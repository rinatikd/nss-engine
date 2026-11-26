// Strict standalone executor for confirmed mutations. The feature remains
// disabled in production until background Control grants and MV3 suspension
// recovery have real-browser acceptance tests.
import { permittedTab } from './read-only-dispatch.js';
import { CONTROL_ORIGINS } from './permissions.js';
import { SESSION_CAPABILITIES } from './session-authorization.js';
import { DEFAULT_ADAPTERS, mergeAdapters } from './adapters.js';
import { pageAction } from './page.js';
import { findSecret, redact } from './secrets.js';
import { normalizeFailure } from './failure-contract.js';

const MUTATIONS = new Set(['browser_click', 'browser_fill', 'agent_send', 'provider_prepare', 'provider_commit']);
const MAX_APPROVAL_MS = 90_000;
const nowExpired = (cmd, now) => !Number.isFinite(cmd?.expires) || now() >= cmd.expires;

async function inject(chromeApi, tabId, origin, name, args, documentId=null) {
  const target = Number.isSafeInteger(tabId) && typeof documentId==='string' && documentId
    ? {tabId,documentIds:[documentId]}
    : {tabId};
  let out;
  try {
    out = await chromeApi.scripting.executeScript({
      target,world:'ISOLATED',func:pageAction,args:[name,args,origin]
    });
  } catch (cause) {
    if (documentId) {
      // Once a command is sent to an exact document, a rejected/missing
      // result is ambiguous: never fall back to the active tab's new document.
      throw Object.assign(Error('DOCUMENT_BOUND_INJECTION_FAILED'),{
        dispatchState:'UNKNOWN'
      });
    }
    throw cause;
  }
  if (!Array.isArray(out) || out.length!==1 ||
      typeof out[0]?.documentId!=='string' || !out[0].documentId ||
      out[0].frameId!==0) {
    // A tab-scoped preflight has not mutated anything; a document-scoped
    // mutation may already have run even if Chrome returned incomplete metadata.
    throw Object.assign(Error('INJECTION_DOCUMENT_IDENTITY_UNAVAILABLE'),{
      dispatchState:documentId?'UNKNOWN':'NOT_PERFORMED'
    });
  }
  if (documentId && out[0].documentId!==documentId)
    throw Object.assign(Error('INJECTION_DOCUMENT_IDENTITY_MISMATCH'),{dispatchState:'UNKNOWN'});
  const result = out[0]?.result;
  if (!result || result.error) {
    const error = Error(result?.error || 'INJECTION_FAILED');
    if (result?.dispatchState) error.dispatchState = result.dispatchState;
    if (result?.sideEffect) error.sideEffect = result.sideEffect;
    if (result?.failure) error.failure = normalizeFailure(result.failure,{stage:'PAGE_ACTION',code:'PAGE_ACTION_FAILED'});
    throw error;
  }
  return {result,documentId:out[0].documentId,frameId:out[0].frameId};
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

async function dispatchProviderMutation(cmd, chromeApi, {
  approvals, controlGrant, sessionAuthorization, stillEnabled=async()=>false, now=Date.now, uuid=()=>crypto.randomUUID()
}={}) {
  let executionStarted=false;
  let stage='PRECHECK';
  const startedAt=now();
  const args=cmd.args;
  try {
    const {requestId,taskId,providerId,tabId,origin,conversationId,epoch}=args;
    if(!/^[A-Za-z0-9_-]{8,100}$/.test(requestId||'') ||
       !/^[A-Za-z0-9_-]{8,100}$/.test(taskId||'') ||
       !Number.isSafeInteger(epoch)||epoch<1 ||
       typeof conversationId!=='string'||!/^[A-Za-z0-9_-]{8,160}$/.test(conversationId) ||
       CONTROL_ORIGINS[origin]!==providerId) throw Error('PROVIDER_IDENTITY_INVALID');
    if(!approvals?.request || (typeof controlGrant!=='function' && !sessionAuthorization))throw Error('BACKGROUND_CONTROL_NOT_CONFIGURED');
    if(!(await stillEnabled()))throw Error('BACKGROUND_CONTROL_STOPPED');
    if(nowExpired(cmd,now))throw Error('COMMAND_EXPIRED');
    const {tab,origin:actualOrigin,site}=await permittedTab(chromeApi,tabId);
    if(actualOrigin!==origin||site.mode!=='chat'||site.adapter!==providerId)
      throw Error('PROVIDER_TAB_BINDING_MISMATCH');
    const sessionState=sessionAuthorization ? await sessionAuthorization.status(cmd.bridgeEpoch) : {active:false};
    const sessionMode=sessionState.active===true && SESSION_CAPABILITIES.includes(cmd.name);
    const controlExpires=sessionMode
      ? await sessionAuthorization.require({origin,tabId,command:cmd.name,bridgeEpoch:cmd.bridgeEpoch})
      : await controlGrant(origin,tabId);
    if(!Number.isFinite(controlExpires)||controlExpires<=now())throw Error('EXPLICIT_CONTROL_GRANT_REQUIRED');
    const {adapters}=await chromeApi.storage.local.get('adapters');
    let overrides;
    try{overrides=JSON.parse(adapters||'{}');}catch{throw Error('INVALID_ADAPTER_CONFIGURATION');}
    const adapter=mergeAdapters(overrides)[providerId];
    if(!adapter||adapter.origin!==origin)throw Error('ADAPTER_ORIGIN_MISMATCH');
    const preflightInjection=await inject(chromeApi,tab.id,origin,'agent_context',{adapter});
    const preflight=preflightInjection.result;
    if(!preflight.verified||preflight.origin!==origin||preflight.conversationId!==conversationId)
      throw Error('CONVERSATION_NOT_BOUND');
    // The tab URL must still match the pre-approval snapshot after document capture.
    await boundTab(chromeApi,tab.id,tab.url,origin);
    if(cmd.name==='provider_prepare') {
      if(typeof args.message!=='string'||!args.message.trim()||args.message.length>100000||
         findSecret(args.message)||!/^[a-f0-9]{64}$/.test(args.payloadHash||'')||
         !/^[A-Za-z0-9_-]{8,100}$/.test(args.preparedId||'')||
         !Number.isFinite(Date.parse(args.expiresAt||''))||Date.parse(args.expiresAt)<=now()||
         Date.parse(args.expiresAt)>now()+120000)throw Error('PROVIDER_PREPARE_INPUT_INVALID');
    } else if(!/^[A-Za-z0-9_-]{8,100}$/.test(args.preparedId||'')||
       !/^[a-f0-9]{64}$/.test(args.fencingToken||'')||
       !/^[a-f0-9]{64}$/.test(args.payloadHash||'')) {
      throw Error('PROVIDER_COMMIT_INPUT_INVALID');
    }

    const expires=Math.min(cmd.expires,now()+MAX_APPROVAL_MS);
    if(expires<=now())throw Error('COMMAND_EXPIRED');
    if(!sessionMode) {
      stage='APPROVAL';
      await approvals.request({
        id:'p-'+uuid(),command:cmd.name,origin,tabId,expires,
        preview:cmd.name==='provider_prepare'
          ? 'Prepare '+providerId+' message · request '+requestId
          : 'Commit prepared '+providerId+' message · request '+requestId,
        contentLength:cmd.name==='provider_prepare'?args.message.length:0
      });
    }

    stage='REVALIDATION';
    if(!(await stillEnabled()))throw Error('BACKGROUND_CONTROL_STOPPED');
    if(nowExpired(cmd,now)||now()>=expires)throw Error('APPROVAL_EXPIRED');
    await boundTab(chromeApi,tab.id,tab.url,origin);
    const refreshedGrant=sessionMode
      ? await sessionAuthorization.require({origin,tabId,command:cmd.name,bridgeEpoch:cmd.bridgeEpoch})
      : await controlGrant(origin,tabId);
    if(!Number.isFinite(refreshedGrant)||refreshedGrant<=now())throw Error('CONTROL_GRANT_EXPIRED');
    const currentInjection=await inject(chromeApi,tab.id,origin,'agent_context',{adapter},preflightInjection.documentId);
    const current=currentInjection.result;
    if(!current.verified||current.origin!==origin||current.conversationId!==conversationId)
      throw Error('CONVERSATION_CHANGED_AFTER_APPROVAL');
    if(!(await stillEnabled()))throw Error('BACKGROUND_CONTROL_STOPPED');

    const pageArgs=cmd.name==='provider_prepare'
      ? {adapter,requestId,epoch,message:args.message,payloadHash:args.payloadHash,preparedId:args.preparedId,
          expiresAt:args.expiresAt,expectedOrigin:origin,expectedConversationId:conversationId,
          controlExpires:refreshedGrant}
      : {adapter,requestId,epoch,payloadHash:args.payloadHash,preparedId:args.preparedId,fencingToken:args.fencingToken,
          expectedOrigin:origin,expectedConversationId:conversationId,controlExpires:refreshedGrant};
    stage='PAGE_ACTION';
    executionStarted=true;
    const finalInjection=await inject(chromeApi,tab.id,origin,cmd.name,pageArgs,currentInjection.documentId);
    const result=finalInjection.result;
    if(cmd.name==='provider_prepare') {
      if(result?.prepared!==true||result.clickedSend!==false||result.requestId!==requestId||
         result.sideEffect!=='composer-filled-no-send'||result.preparedId!==args.preparedId||
         result.payloadHash!==args.payloadHash)throw Error('PROVIDER_PREPARE_RECEIPT_INVALID');
    } else if(result?.clickedSend!==true||result.requestId!==requestId||result.preparedId!==args.preparedId||
      result.payloadHash!==args.payloadHash||!Number.isFinite(Date.parse(result.clickedAt||''))) {
      throw Error('PROVIDER_COMMIT_RECEIPT_INVALID');
    }
    return result;
  } catch(error) {
    if(!executionStarted) {
      if(!/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message||'')) {
        error=Object.assign(new Error('PROVIDER_'+stage+'_FAILED'),{dispatchState:error?.dispatchState});
      }
      error.dispatchState=/^(USER_DENIED|APPROVAL_CANCELLED|BACKGROUND_CONTROL_STOPPED|EXPLICIT_CONTROL_GRANT_REQUIRED|CONTROL_GRANT_EXPIRED|CONTROL_ORIGIN_DENIED|PROVIDER_TAB_BINDING_MISMATCH)$/.test(error.message)
        ? 'BLOCKED':'NOT_PERFORMED';
    } else if(cmd.name==='provider_prepare' && !['BLOCKED','NOT_PERFORMED'].includes(error?.dispatchState)) {
      // provider_prepare never clicks Send. Even if its browser response is
      // lost after injection, submission is known not to have occurred.
      // Preserve a bounded note about a possibly remaining unsent draft.
      error.dispatchState='NOT_PERFORMED';
      error.sideEffect=error.sideEffect||'composer-draft-state-unverified';
    }
    error.failure=normalizeFailure(error.failure,{
      stage:executionStarted?'PAGE_ACTION':stage,
      code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message||'')?error.message:'PROVIDER_'+stage+'_FAILED',
      startedAt,now
    });
    throw error;
  }
}
export async function dispatchMutation(cmd, chromeApi, {
  approvals, controlGrant, sessionAuthorization, stillEnabled=async()=>false, now=Date.now, uuid=()=>crypto.randomUUID()
}={}) {
  let executionStarted=false;
  // Stage codes are safe metadata: never expose provider text, prompts, or DOM content.
  let stage='PRECHECK';
  const startedAt=now();
  try {
  exactCommand(cmd);
  if (cmd.name === 'provider_prepare' || cmd.name === 'provider_commit') {
    return dispatchProviderMutation(cmd,chromeApi,{approvals,controlGrant,sessionAuthorization,stillEnabled,now,uuid});
  }
  if (!approvals?.request || (typeof controlGrant !== 'function' && !sessionAuthorization))
    throw Error('BACKGROUND_CONTROL_NOT_CONFIGURED');
  if (!(await stillEnabled())) throw Error('BACKGROUND_CONTROL_STOPPED');
  if (nowExpired(cmd,now)) throw Error('COMMAND_EXPIRED');
  const {tab,origin} = await permittedTab(chromeApi,cmd.args.tabId);
  if (CONTROL_ORIGINS[origin] == null) throw Error('CONTROL_ORIGIN_DENIED');
  await boundTab(chromeApi,tab.id,tab.url,origin);
  const sessionState=sessionAuthorization ? await sessionAuthorization.status(cmd.bridgeEpoch) : {active:false};
  const sessionMode=sessionState.active===true && SESSION_CAPABILITIES.includes(cmd.name);
  const controlExpires=sessionMode
    ? await sessionAuthorization.require({origin,tabId:tab.id,command:cmd.name,bridgeEpoch:cmd.bridgeEpoch})
    : await controlGrant(origin,tab.id);
  if (!Number.isFinite(controlExpires) || controlExpires <= now())
    throw Error('EXPLICIT_CONTROL_GRANT_REQUIRED');

  const expires = Math.min(cmd.expires,now()+MAX_APPROVAL_MS);
  if (expires<=now()) throw Error('COMMAND_EXPIRED');
  let adapter;
  let preflight;
  let preflightInjection;
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
    preflightInjection = await inject(chromeApi,tab.id,origin,'agent_context',{adapter});
    preflight = preflightInjection.result;
    if (!preflight.verified || preflight.origin!==origin ||
        preflight.conversationId!==cmd.args.expectedConversationId)
      throw Error('CONVERSATION_CHANGED');
  } else {
    if (typeof cmd.args.selector!=='string' || !cmd.args.selector ||
        cmd.args.selector.length>300) throw Error('INVALID_SELECTOR');
    preflightInjection = await inject(chromeApi,tab.id,origin,'describe',
      {selector:cmd.args.selector});
    preflight = preflightInjection.result;
    if (cmd.name === 'browser_fill' &&
        (typeof cmd.args.text!=='string' || cmd.args.text.length>10000 ||
         findSecret(cmd.args.text))) throw Error('INVALID_OR_SENSITIVE_FILL');
  }

  // Recheck tab URL/origin after capturing the preflight document. Approval
  // must not be presented for a different same-origin navigation.
  await boundTab(chromeApi,tab.id,tab.url,origin);

  // Only metadata is surfaced in the queue. Do not persist prompt contents.
  const approvalId='m-'+uuid();
  const preview = cmd.name === 'agent_send'
    ? redact(cmd.args.text.slice(0,180))
    : cmd.name === 'browser_fill'
      ? 'Поле: ' + cmd.args.selector + ' · текст: ' + redact(cmd.args.text.slice(0,80))
      : 'Элемент: ' + String(preflight.text || cmd.args.selector).slice(0,160);
  if(!sessionMode) {
    stage='APPROVAL';
    await approvals.request({
      id:approvalId,command:cmd.name,origin,tabId:tab.id,expires,
      preview:preview.slice(0,240),contentLength:cmd.args.text?.length || 0
    });
  }

  stage='REVALIDATION';
  if (!(await stillEnabled())) throw Error('BACKGROUND_CONTROL_STOPPED');
  // Revalidate EVERYTHING after human approval and immediately before DOM
  // action; a changed origin, URL, conversation or grant must fail closed.
  if (nowExpired(cmd,now) || now()>=expires) throw Error('APPROVAL_EXPIRED');
  await boundTab(chromeApi,tab.id,tab.url,origin);
  const refreshedGrant=sessionMode
    ? await sessionAuthorization.require({origin,tabId:tab.id,command:cmd.name,bridgeEpoch:cmd.bridgeEpoch})
    : await controlGrant(origin,tab.id);
  if (!Number.isFinite(refreshedGrant) || refreshedGrant<=now())
    throw Error('CONTROL_GRANT_EXPIRED');

  let args;
  let currentInjection;
  if (cmd.name === 'agent_send') {
    currentInjection = await inject(chromeApi,tab.id,origin,'agent_context',{adapter},preflightInjection.documentId);
    const current = currentInjection.result;
    if (!current.verified || current.origin!==origin ||
        current.conversationId!==cmd.args.expectedConversationId)
      throw Error('CONVERSATION_CHANGED_AFTER_APPROVAL');
    args={...cmd.args,adapter,controlExpires:refreshedGrant};
  } else {
    currentInjection=await inject(chromeApi,tab.id,origin,'describe',
      {selector:cmd.args.selector},preflightInjection.documentId);
    const current=currentInjection.result;
    if (current.tag!==preflight.tag || current.text!==preflight.text ||
        current.href!==preflight.href || current.formAction!==preflight.formAction)
      throw Error('TARGET_CHANGED_AFTER_APPROVAL');
    args={...cmd.args,controlExpires:refreshedGrant,
      expect:{tag:current.tag,text:current.text}};
  }
  if (!(await stillEnabled())) throw Error('BACKGROUND_CONTROL_STOPPED');
  // At most one dispatch. Failed confirmations are UNKNOWN, never retried.
  stage='PAGE_ACTION';
  executionStarted=true;
  const finalInjection=await inject(chromeApi,tab.id,origin,cmd.name,args,currentInjection.documentId);
  const result=finalInjection.result;
  return result?.text ? {...result,text:redact(result.text)} : result;
  } catch(error) {
    // This flag can only be set if the single DOM mutation injection has NOT
    // started. Post-injection errors remain UNKNOWN to prevent duplicate sends.
    if (!executionStarted) {
      // Preserve existing stable error codes; replace free-form exceptions with
      // bounded stage identifiers so the server can report a safe failureCode.
      if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '')) {
        error = Object.assign(new Error(`MUTATION_${stage}_FAILED`), {
          dispatchState: error?.dispatchState
        });
      }
      error.dispatchState = /^(USER_DENIED|APPROVAL_CANCELLED|BACKGROUND_CONTROL_STOPPED|EXPLICIT_CONTROL_GRANT_REQUIRED|CONTROL_GRANT_EXPIRED|CONTROL_ORIGIN_DENIED|CONTROL_SITE_DENIED)$/.test(error.message)
        ? 'BLOCKED' : 'NOT_PERFORMED';
    }
    error.failure=normalizeFailure(error.failure,{
      stage:executionStarted?'PAGE_ACTION':stage,
      code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message||'')?error.message:'MUTATION_'+stage+'_FAILED',
      startedAt,now
    });
    throw error;
  }
}
