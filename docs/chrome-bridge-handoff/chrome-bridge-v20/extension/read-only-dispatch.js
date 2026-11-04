import { pageAction } from './page.js';
import { redact } from './secrets.js';

const MUTATING = new Set(['browser_open','browser_click','browser_fill','agent_send','agent_new_chat']);
const LOCAL = new Set(['localhost','127.0.0.1','[::1]']);
const ALLOWED = new Set(['browser_tabs','browser_read','control_status']);

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
        const {origin,site} = await permittedTab(chromeApi,t.id);
        // Re-check the current URL rather than returning stale query results.
        out.push({tabId:t.id,title:redact(t.title || ''),url:redact(t.url),
          mode:site.mode || 'read',adapter:site.adapter || null,
          active:!!t.active,windowId:t.windowId,origin});
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
