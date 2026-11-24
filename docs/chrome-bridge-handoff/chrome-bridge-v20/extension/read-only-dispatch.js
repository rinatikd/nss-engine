import { pageAction } from './page.js';
import { redact } from './secrets.js';
import { CONTROL_ORIGINS } from './permissions.js';
import { mergeAdapters } from './adapters.js';

const MUTATING = new Set(['browser_open','browser_click','browser_fill','agent_send','provider_prepare','provider_commit','agent_new_chat']);
const LOCAL = new Set(['localhost','127.0.0.1','[::1]']);
const ALLOWED = new Set(['browser_tabs','browser_read','control_status',
  'agent_probe','agent_selftest','agent_context','agent_peek','provider_reply_peek']);

export async function permittedTab(chromeApi, tabId) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw Error('INVALID_TAB_ID');
  const tab = await chromeApi.tabs.get(tabId);
  if (!tab?.url) throw Error('TAB_HAS_NO_URL');
  const url = new URL(tab.url);
  if (url.protocol !== 'https:' || LOCAL.has(url.hostname)) throw Error('ORIGIN_NOT_PERMITTED');
  const { sites = {} } = await chromeApi.storage.local.get('sites');
  if (!Object.hasOwn(sites,url.origin)) throw Error('ORIGIN_NOT_PERMITTED');
  const allowed = await chromeApi.permissions.contains({origins:[url.origin+'/*']});
  if (!allowed) throw Error('HOST_PERMISSION_MISSING');
  return {tab,origin:url.origin,site:sites[url.origin]};
}
export async function dispatchReadOnly(command, chromeApi, {getBackgroundControlStatus} = {}) {
  if (!command || typeof command !== 'object' || typeof command.name !== 'string')
    throw Error('INVALID_COMMAND');
  if (MUTATING.has(command.name)) throw Error('CONTROL_REQUIRES_APPROVAL_UI');
  if (!ALLOWED.has(command.name)) throw Error('BACKGROUND_COMMAND_NOT_MIGRATED');

  if (command.name === 'control_status') {
    let backgroundControl;
    try {
      backgroundControl=typeof getBackgroundControlStatus==='function'
        ? await getBackgroundControlStatus() : null;
    } catch { backgroundControl=null; }
    const available=backgroundControl?.available===true;
    const byOrigin=new Map();
    for (const grant of (available && Array.isArray(backgroundControl.grants)
      ? backgroundControl.grants : [])) {
      if (!grant || !Object.hasOwn(CONTROL_ORIGINS,grant.origin) ||
          !Number.isSafeInteger(grant.tabId) || !Number.isFinite(grant.expiresAt)) continue;
      let item=byOrigin.get(grant.origin);
      if (!item) {
        item={origin:grant.origin,effective:true,expiresAt:grant.expiresAt,tabs:[]};
        byOrigin.set(grant.origin,item);
      }
      item.expiresAt=Math.max(item.expiresAt,grant.expiresAt);
      item.tabs.push({tabId:grant.tabId,expiresAt:grant.expiresAt});
    }
    return {
      connected:available && backgroundControl.connected===true,
      globalEnabled:false,
      approvalPending:available ? backgroundControl.approvalPending : 0,
      origins:[...byOrigin.values()],
      controlMode:'background',
      legacyControl:{globalEnabled:false,approvalPending:0,origins:[]},
      backgroundControl:available ? backgroundControl : {
        available:false,grantsKnown:false,activeCount:null,grants:[],
        error:'BACKGROUND_STATUS_UNAVAILABLE'
      }
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
  if (['agent_probe','agent_selftest','agent_context','agent_peek','provider_reply_peek'].includes(command.name)) {
    const tabId=command.args?.tabId;
    const {tab,origin,site}=await permittedTab(chromeApi,tabId);
    // These are diagnosis/read operations only, never a write permission.
    if (!Object.hasOwn(CONTROL_ORIGINS,origin) ||
        site.mode!=='chat' || site.adapter!==CONTROL_ORIGINS[origin])
      throw Error('AGENT_SITE_NOT_APPROVED');
    const {adapters} = await chromeApi.storage.local.get('adapters');
    let overrides;
    try { overrides=JSON.parse(adapters || '{}'); }
    catch { throw Error('INVALID_ADAPTER_CONFIGURATION'); }
    const adapter=mergeAdapters(overrides)[site.adapter];
    if (!adapter || adapter.origin!==origin)
      throw Error('ADAPTER_ORIGIN_MISMATCH');
    if (command.name==='provider_reply_peek' &&
        (command.args?.expectedOrigin!==origin ||
         typeof command.args?.expectedConversationId!=='string' ||
         !/^[A-Za-z0-9_-]{8,160}$/.test(command.args.expectedConversationId))) {
      throw Error('PROVIDER_REPLY_IDENTITY_INVALID');
    }
    const action=command.name==='agent_probe'?'agent_selftest':command.name;
    const actionArgs=command.name==='provider_reply_peek'
      ? {adapter,expectedOrigin:origin,expectedConversationId:command.args.expectedConversationId}
      : {adapter};
    const results=await chromeApi.scripting.executeScript({
      target:{tabId},func:pageAction,args:[action,actionArgs,origin]
    });
    const result=results?.[0]?.result;
    if (!result || result.error) throw Error(result?.error || 'AGENT_DIAGNOSTIC_FAILED');
    const check=await chromeApi.tabs.get(tabId);
    if (check.url!==tab.url) throw Error('TAB_CHANGED_DURING_READ');
    if (command.name==='agent_probe') {
      if (!result.composer || !result.send) throw Error('INVALID_PROBE_RESULT');
      return {adapter:site.adapter,
        // The send button may be invisible on an empty composer; binding
        // remains possible, but adapterVerified is only true when both are visible.
        verified:result.composer.visible===1 && result.send.visible===1};
    }
    if (command.name==='agent_context') {
      if (typeof result.verified!=='boolean' || result.origin!==origin ||
          (result.conversationId!=null && typeof result.conversationId!=='string'))
        throw Error('INVALID_AGENT_CONTEXT');
      return result;
    }
    if (command.name==='agent_peek') {
      if (!Number.isSafeInteger(result.count) ||
          typeof result.text!=='string' || typeof result.generating!=='boolean')
        throw Error('INVALID_PEEK_RESULT');
      return {...result,text:redact(result.text)};
    }
    if (command.name==='provider_reply_peek') {
      if (!Number.isSafeInteger(result.count) || result.replyIndex!==result.count ||
          typeof result.text!=='string' || !Number.isSafeInteger(result.chars) ||
          result.chars!==result.text.length || typeof result.generating!=='boolean' ||
          result.origin!==origin || result.conversationId!==command.args.expectedConversationId ||
          typeof result.url!=='string') throw Error('INVALID_PROVIDER_REPLY_SNAPSHOT');
      const check=await chromeApi.tabs.get(tabId);
      if (check.url!==tab.url || check.url!==result.url) throw Error('TAB_CHANGED_DURING_PROVIDER_REPLY_READ');
      const sanitized=redact(result.text);
      return {...result,text:sanitized,chars:sanitized.length,redacted:sanitized!==result.text};
    }
    return result;
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
