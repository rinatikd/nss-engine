// Strict standalone executor for confirmed mutations. The feature remains
// disabled in production until background Control grants and MV3 suspension
// recovery have real-browser acceptance tests.
import { permittedTab } from './read-only-dispatch.js';
import { CONTROL_ORIGINS } from './permissions.js';
import { DEFAULT_ADAPTERS, mergeAdapters } from './adapters.js';
import { pageAction } from './page.js';
import { findSecret, redact } from './secrets.js';

const MUTATIONS = new Set(['browser_click', 'browser_fill', 'agent_send']);
const MAX_APPROVAL_MS = 90_000;
const nowExpired = (cmd, now) => !Number.isFinite(cmd?.expires) || now() >= cmd.expires;

async function inject(chromeApi, tabId, origin, name, args) {
  const out = await chromeApi.scripting.executeScript({
    target:{ tabId }, func:pageAction, args:[name,args,origin]
  });
  const result = out?.[0]?.result;
  if (!result || result.error) throw Error(result?.error || 'INJECTION_FAILED');
  return result;
}
function exactCommand(cmd) {
  if (!cmd || !MUTATIONS.has(cmd.name) || !cmd.args ||
      typeof cmd.args !== 'object' || !Number.isSafeInteger(cmd.args.tabId))
    throw Error('INVALID_MUTATION_COMMAND');
  if (!Number.isFinite(cmd.expires)) throw Error('COMMAND_EXPIRED');
}
async function boundTab(chromeApi, tabId, originalUrl, origin) {
  const current = await permittedTab(chromeApi, tabId);
  if (current.tab.url !== originalUrl || current.origin !== origin)
    throw Error('TAB_CHANGED_AFTER_APPROVAL');
  if (CONTROL_ORIGINS[origin] !== current.site.adapter ||
      current.site.mode !== 'chat') throw Error('CONTROL_SITE_DENIED');
  return current;
}
export async function dispatchMutation(cmd, chromeApi, {
  approvals, controlGrant, now=Date.now, uuid=()=>crypto.randomUUID()
}={}) {
  exactCommand(cmd);
  if (!approvals?.request || typeof controlGrant !== 'function')
    throw Error('BACKGROUND_CONTROL_NOT_CONFIGURED');
  if (nowExpired(cmd,now)) throw Error('COMMAND_EXPIRED');
  const {tab,origin} = await permittedTab(chromeApi,cmd.args.tabId);
  if (CONTROL_ORIGINS[origin] == null) throw Error('CONTROL_ORIGIN_DENIED');
  await boundTab(chromeApi,tab.id,tab.url,origin);
  const controlExpires = await controlGrant(origin,tab.id);
  if (!Number.isFinite(controlExpires) || controlExpires <= now())
    throw Error('EXPLICIT_CONTROL_GRANT_REQUIRED');

  const expires = Math.min(cmd.expires,now()+MAX_APPROVAL_MS);
  if (expires<=now()) throw Error('COMMAND_EXPIRED');
  let adapter;
  let preflight;
  if (cmd.name === 'agent_send') {
    if (typeof cmd.args.text !== 'string' || !cmd.args.text.trim() ||
        cmd.args.text.length > 12000) throw Error('INVALID_PROMPT');
    if (findSecret(cmd.args.text)) throw Error('PROMPT_CONTAINS_SECRET');
    if (cmd.args.expectedOrigin !== origin ||
        typeof cmd.args.expectedConversationId !== 'string')
      throw Error('CONVERSATION_NOT_BOUND');
    const {adapters} = await chromeApi.storage.local.get('adapters');
    let overrides;
    try { overrides = JSON.parse(adapters || '{}'); }
    catch { throw Error('INVALID_ADAPTER_CONFIGURATION'); }
    adapter = mergeAdapters(overrides)[CONTROL_ORIGINS[origin]] ||
      DEFAULT_ADAPTERS[CONTROL_ORIGINS[origin]];
    if (!adapter || adapter.origin !== origin) throw Error('ADAPTER_ORIGIN_MISMATCH');
    preflight = await inject(chromeApi,tab.id,origin,'agent_context',{adapter});
    if (!preflight.verified || preflight.origin!==origin ||
        preflight.conversationId!==cmd.args.expectedConversationId)
      throw Error('CONVERSATION_CHANGED');
  } else {
    if (typeof cmd.args.selector!=='string' || !cmd.args.selector ||
        cmd.args.selector.length>300) throw Error('INVALID_SELECTOR');
    preflight = await inject(chromeApi,tab.id,origin,'describe',
      {selector:cmd.args.selector});
    if (cmd.name === 'browser_fill' &&
        (typeof cmd.args.text!=='string' || cmd.args.text.length>10000 ||
         findSecret(cmd.args.text))) throw Error('INVALID_OR_SENSITIVE_FILL');
  }

  // Only metadata is surfaced in the queue. Do not persist prompt contents.
  const approvalId='m-'+uuid();
  await approvals.request({
    id:approvalId,command:cmd.name,origin,tabId:tab.id,expires
  });

  // Revalidate EVERYTHING after human approval and immediately before DOM
  // action; a changed origin, URL, conversation or grant must fail closed.
  if (nowExpired(cmd,now) || now()>=expires) throw Error('APPROVAL_EXPIRED');
  await boundTab(chromeApi,tab.id,tab.url,origin);
  const refreshedGrant = await controlGrant(origin,tab.id);
  if (!Number.isFinite(refreshedGrant) || refreshedGrant<=now())
    throw Error('CONTROL_GRANT_EXPIRED');

  let args;
  if (cmd.name === 'agent_send') {
    const current = await inject(chromeApi,tab.id,origin,'agent_context',{adapter});
    if (!current.verified || current.origin!==origin ||
        current.conversationId!==cmd.args.expectedConversationId)
      throw Error('CONVERSATION_CHANGED_AFTER_APPROVAL');
    args={...cmd.args,adapter,controlExpires:refreshedGrant};
  } else {
    const current=await inject(chromeApi,tab.id,origin,'describe',
      {selector:cmd.args.selector});
    if (current.tag!==preflight.tag || current.text!==preflight.text ||
        current.href!==preflight.href || current.formAction!==preflight.formAction)
      throw Error('TARGET_CHANGED_AFTER_APPROVAL');
    args={...cmd.args,controlExpires:refreshedGrant,
      expect:{tag:current.tag,text:current.text}};
  }
  // At most one dispatch. Failed confirmations are UNKNOWN, never retried.
  const result=await inject(chromeApi,tab.id,origin,cmd.name,args);
  return result?.text ? {...result,text:redact(result.text)} : result;
}
