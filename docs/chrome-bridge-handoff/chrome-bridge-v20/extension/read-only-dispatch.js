import { pageAction } from './page.js';
import { redact } from './secrets.js';
import { providerForOrigin } from './permissions.js';
import { eligibleWebUrl } from './one-click-session.js';

const MUTATING = new Set(['browser_open','browser_click','browser_fill','agent_send','agent_new_chat']);
const LOCAL = new Set(['localhost','127.0.0.1','[::1]']);
const ALLOWED = new Set(['browser_tabs','browser_read','control_status']);

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
export async function dispatchReadOnly(command, chromeApi) {
  if (!command || typeof command !== 'object' || typeof command.name !== 'string')
    throw Error('INVALID_COMMAND');
  if (MUTATING.has(command.name)) throw Error('CONTROL_REQUIRES_APPROVAL_UI');
  if (!ALLOWED.has(command.name)) throw Error('BACKGROUND_COMMAND_NOT_MIGRATED');

  if (command.name === 'control_status') return {
    connected:true,
    globalEnabled:false,
    approvalPending:0,
    origins:[]
  };
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
