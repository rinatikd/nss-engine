import { requireOneClickControl } from './one-click-control-gate.js';
// One-click routine DOM executor. It never trusts a page or stale tab state,
// and never handles secrets, privileged Chrome pages or arbitrary OS commands.
import { permittedTab } from './read-only-dispatch.js';
import { providerForOrigin } from './permissions.js';
import { DEFAULT_ADAPTERS, mergeAdapters } from './adapters.js';
import { pageAction } from './page.js';
import { findSecret, redact } from './secrets.js';

const ACTIONS = new Set(['browser_click','browser_fill','agent_send']);
const SENSITIVE = /(?:checkout|payment|billing|transfer|withdraw|delete.account|remove.account|purchase|password|oauth|2fa|security.settings)/i;
const SENSITIVE_ACTION = /(?:pay|purchase|checkout|transfer|delete|remove|unsubscribe|submit.order|confirm.payment|password|credential|token|secret|api.key)/i;
const expired = c => !Number.isFinite(c?.expires) || c.expires <= Date.now();
async function inject(api,tabId,origin,name,args) {
  const r=await api.scripting.executeScript({
    target:{tabId},func:pageAction,args:[name,args,origin]
  });
  const v=r?.[0]?.result;
  if(!v || v.error) throw Error(v?.error || 'INJECTION_FAILED');
  return v;
}
async function stableTab(api,id,url,origin) {
  const t=await permittedTab(api,id);
  if(t.tab.url!==url || t.origin!==origin) throw Error('TAB_CHANGED');
  if(SENSITIVE.test(url)) throw Error('SENSITIVE_PAGE_REQUIRES_SEPARATE_APPROVAL');
  return t;
}
export async function dispatchOneClickMutation(cmd, api) {
  if(!cmd || !ACTIONS.has(cmd.name) || !Number.isSafeInteger(cmd.args?.tabId) ||
      expired(cmd)) throw Error('INVALID_OR_EXPIRED_COMMAND');
  await requireOneClickControl(api);
  const {tab,origin}=await permittedTab(api,cmd.args.tabId);
  if(SENSITIVE.test(tab.url)) throw Error('SENSITIVE_PAGE_REQUIRES_SEPARATE_APPROVAL');
  let preflight,adapter;
  if(cmd.name==='agent_send') {
    const provider=providerForOrigin(origin);
    if(!['claude','gemini','deepseek'].includes(provider)) throw Error('AGENT_ADAPTER_NOT_VERIFIED');
    const text=cmd.args.text;
    if(typeof text!=='string'||!text.trim()||text.length>12000||findSecret(text))
      throw Error('INVALID_OR_SENSITIVE_MESSAGE');
    if(cmd.args.expectedOrigin!==origin ||
       typeof cmd.args.expectedConversationId!=='string')
      throw Error('CONVERSATION_NOT_BOUND');
    const {adapters}=await api.storage.local.get('adapters');
    let overrides;
    try{overrides=JSON.parse(adapters||'{}');}catch{throw Error('INVALID_ADAPTER_CONFIGURATION');}
    adapter=mergeAdapters(overrides)[provider] || DEFAULT_ADAPTERS[provider];
    if(!adapter || adapter.origin!==origin) throw Error('ADAPTER_ORIGIN_MISMATCH');
    preflight=await inject(api,tab.id,origin,'agent_context',{adapter});
    if(!preflight.verified||preflight.origin!==origin||
       preflight.conversationId!==cmd.args.expectedConversationId)
      throw Error('CONVERSATION_CHANGED');
  } else {
    if(typeof cmd.args.selector!=='string'||!cmd.args.selector||
       cmd.args.selector.length>300) throw Error('INVALID_SELECTOR');
    if(SENSITIVE_ACTION.test(cmd.args.selector)) throw Error('SENSITIVE_ACTION_REQUIRES_APPROVAL');
    if(cmd.name==='browser_fill' &&
       (typeof cmd.args.text!=='string'||cmd.args.text.length>10000||findSecret(cmd.args.text)))
      throw Error('SENSITIVE_FILL_DENIED');
    preflight=await inject(api,tab.id,origin,'describe',{selector:cmd.args.selector});
    if(SENSITIVE_ACTION.test([preflight.text,preflight.href,preflight.formAction].join(' ')))
      throw Error('SENSITIVE_ACTION_REQUIRES_APPROVAL');
  }
  // Revalidate immediately before acting. There is no background approval queue.
  await requireOneClickControl(api);
  if(expired(cmd)) throw Error('COMMAND_EXPIRED');
  await stableTab(api,tab.id,tab.url,origin);
  let args;
  if(cmd.name==='agent_send') {
    const current=await inject(api,tab.id,origin,'agent_context',{adapter});
    if(!current.verified||current.origin!==origin||
       current.conversationId!==preflight.conversationId)
      throw Error('CONVERSATION_CHANGED');
    args={...cmd.args,adapter,controlExpires:cmd.expires,allTabsSession:true};
  } else {
    const current=await inject(api,tab.id,origin,'describe',{selector:cmd.args.selector});
    if(current.tag!==preflight.tag||current.text!==preflight.text||
       current.href!==preflight.href||current.formAction!==preflight.formAction)
      throw Error('TARGET_CHANGED');
    args={...cmd.args,expect:{tag:current.tag,text:current.text},
      controlExpires:cmd.expires,allTabsSession:true};
  }
  // Last pre-dispatch check. Dispatch is at-most-once; UNKNOWN is never retried here.
  await requireOneClickControl(api);
  if(expired(cmd)) throw Error('COMMAND_EXPIRED');
  await stableTab(api,tab.id,tab.url,origin);
  const result=await inject(api,tab.id,origin,cmd.name,args);
  return result?.text ? {...result,text:redact(result.text)} : result;
}
