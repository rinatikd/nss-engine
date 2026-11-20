import { pageAction } from './page.js';
import { redact } from './secrets.js';
import { providerForOrigin } from './permissions.js';
import { eligibleWebUrl } from './one-click-session.js';
import { DEFAULT_ADAPTERS, mergeAdapters } from './adapters.js';

const MUTATING = new Set(['browser_open','browser_click','browser_fill','agent_send','agent_new_chat']);
const LOCAL = new Set(['localhost','127.0.0.1','[::1]']);
const ALLOWED = new Set(['browser_tabs','browser_read','control_status',
  'agent_probe','agent_context','agent_peek','agent_selftest']);

export async function permittedTab(chromeApi, tabId) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw Error('INVALID_TAB_ID');
  const tab = await chromeApi.tabs.get(tabId);
  if (!tab?.url) throw Error('TAB_HAS_NO_URL');
  const url = new URL(tab.url);
  if (!eligibleWebUrl(tab.url) || LOCAL.has(url.hostname)) throw Error('ORIGIN_NOT_PERMITTED');
  const { sites = {}, bridgeAllTabsMode, bridgeConnectionDesired } =
    await chromeApi.storage.local.get(['sites','bridgeAllTabsMode','bridgeConnectionDesired']);
  const allTabsEnabled = bridgeAllTabsMode === true && bridgeConnectionDesired === true;
  if (!allTabsEnabled && !Object.hasOwn(sites,url.origin)) throw Error('ORIGIN_NOT_PERMITTED');
  const allowed = await chromeApi.permissions.contains({origins:[url.origin+'/*']});
  if (!allowed) throw Error('HOST_PERMISSION_MISSING');
  const provider = providerForOrigin(url.origin);
  const site = allTabsEnabled
    ? {mode:provider?'chat':'read',adapter:provider || null}
    : sites[url.origin];
  return {tab,origin:url.origin,site};
}
export async function dispatchReadOnly(command, chromeApi, {transportStatus=null} = {}) {
  if (!command || typeof command !== 'object' || typeof command.name !== 'string')
    throw Error('INVALID_COMMAND');
  if (MUTATING.has(command.name)) throw Error('CONTROL_REQUIRES_APPROVAL_UI');
  if (!ALLOWED.has(command.name)) throw Error('BACKGROUND_COMMAND_NOT_MIGRATED');

  if (command.name === 'control_status') {
    const {bridgeBackgroundMode,bridgeConnectionDesired,bridgeAllTabsMode,bridgeMutationLabMode} =
      await chromeApi.storage.local.get([
        'bridgeBackgroundMode','bridgeConnectionDesired','bridgeAllTabsMode','bridgeMutationLabMode'
      ]);
    const desired = bridgeBackgroundMode===true && bridgeConnectionDesired===true;
    // Desired connection is not evidence of a live transport. Only a recent
    // coordinator-observed handshake may report connected.
    const connected = desired && transportStatus?.connected === true;
    let permissionsOk=false;
    if (connected && bridgeAllTabsMode===true && bridgeMutationLabMode===true &&
        typeof chromeApi.permissions?.contains==='function') {
      try {
        permissionsOk = (await chromeApi.permissions.contains({origins:['http://*/*']})) === true &&
          (await chromeApi.permissions.contains({origins:['https://*/*']})) === true;
      } catch { permissionsOk=false; }
    }
    return {
      connected,
      connectionDesired:desired,
      globalEnabled:connected && bridgeAllTabsMode===true &&
        bridgeMutationLabMode===true && permissionsOk,
      approvalPending:0,
      origins:[],
      scope:bridgeAllTabsMode===true ? 'permitted-web-tabs' : 'legacy-sites'
    };
  }
  if (command.name === 'browser_tabs') {
    const tabs = await chromeApi.tabs.query({});
    const out=[];
    for (const t of tabs) {
      if (!Number.isSafeInteger(t.id) || !t.url) continue;
      try {
        const {tab,origin,site} = await permittedTab(chromeApi,t.id);
        // Re-check the current URL rather than returning stale query results.
        out.push({tabId:tab.id,title:redact(tab.title || ''),url:redact(tab.url),
          mode:site.mode || 'read',adapter:site.adapter || null,
          active:!!tab.active,windowId:tab.windowId,origin});
      } catch { /* do not disclose unapproved tabs */ }
    }
    return out;
  }
  if (['agent_probe','agent_context','agent_peek','agent_selftest'].includes(command.name)) {
    const tabId=command.args?.tabId;
    const {tab,origin,site}=await permittedTab(chromeApi,tabId);
    if(site.mode!=='chat' || !site.adapter || site.adapter!==providerForOrigin(origin))
      throw Error('VERIFIED_CHAT_ADAPTER_REQUIRED');
    const {adapters}=await chromeApi.storage.local.get('adapters');
    let overrides;
    try {overrides=JSON.parse(adapters||'{}');} catch {throw Error('INVALID_ADAPTER_CONFIGURATION');}
    const adapter=mergeAdapters(overrides)[site.adapter] || DEFAULT_ADAPTERS[site.adapter];
    if(!adapter || adapter.origin!==origin) throw Error('ADAPTER_ORIGIN_MISMATCH');
    const requested=command.name==='agent_probe'?'agent_selftest':command.name;
    const result=await chromeApi.scripting.executeScript({
      target:{tabId},func:pageAction,args:[requested,{...command.args,adapter},origin]
    });
    const check=await chromeApi.tabs.get(tabId);
    if(check.url!==tab.url) throw Error('TAB_CHANGED_DURING_READ');
    const v=result?.[0]?.result;
    if(!v || v.error) throw Error(v?.error || 'INVALID_AGENT_RESULT');
    if(command.name==='agent_probe')
      return {adapter:site.adapter,verified:v.composer?.visible===1 && v.send?.visible===1};
    return typeof v.text==='string' ? {...v,text:redact(v.text)} : v;
  }
  if (command.name === 'browser_read') {
    const tabId = command.args?.tabId;
    const {tab,origin} = await permittedTab(chromeApi,tabId);
    const args = {selector:command.args?.selector};
    if (args.selector != null && (typeof args.selector !== 'string' ||
        args.selector.length > 300)) throw Error('INVALID_SELECTOR');
    const results = await chromeApi.scripting.executeScript({
      target:{tabId}, func:pageAction,
      args:['browser_read',args,origin]
    });
    // Reject result if the tab navigated during the injected read.
    const check = await chromeApi.tabs.get(tabId);
    if (check.url !== tab.url) throw Error('TAB_CHANGED_DURING_READ');
    const result=results?.[0]?.result;
    if (!result || result.error || typeof result.text !== 'string' ||
        !Array.isArray(result.links)) throw Error(result?.error || 'INVALID_READ_RESULT');
    return {...result,text:redact(result.text),
      links:result.links.map(x=>({text:redact(String(x.text || '')),
        url:redact(String(x.url || ''))}))};
  }
  throw Error('BACKGROUND_COMMAND_NOT_MIGRATED');
}
