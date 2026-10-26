export const SendState = Object.freeze({CONFIRMED:'send-confirmed',UNKNOWN:'send-unknown',NOT_PERFORMED:'send-not-performed',BLOCKED:'send-blocked'});
const result=(state,reasons)=>Object.freeze({state,reasons,autoRetry:false});
const validId=x=>typeof x==='string'&&x.length>0;
const validTabId=x=>Number.isSafeInteger(x)&&x>0;
const validOrigin=x=>x==='https://claude.ai'||x==='https://gemini.google.com'||x==='https://chat.deepseek.com';
const delta=(a,b)=>Number.isSafeInteger(a)&&Number.isSafeInteger(b)&&a>=0&&b>=a?b-a:null;
/** Fail-closed classifier. Counts alone cannot attribute a message to this request. */
export function classifySend(e){
 if(!e||typeof e!=='object')return result(SendState.UNKNOWN,['NO_EVIDENCE']);
 if(e.dispatched===false)return result(e.controlDenied?SendState.BLOCKED:SendState.NOT_PERFORMED,[e.controlDenied?'CONTROL_DENIED':'NO_DISPATCH']);
 if(e.dispatched!==true)return result(SendState.UNKNOWN,['DISPATCH_UNCERTAIN']);
 if(!validTabId(e.tabId)||!validOrigin(e.origin)||!validId(e.conversationFingerprint)||!validId(e.requestId))return result(SendState.UNKNOWN,['CONTEXT_UNAVAILABLE']);
 if(e.after?.tabId!==e.tabId||e.after?.origin!==e.origin||e.after?.conversationFingerprint!==e.conversationFingerprint||e.after?.requestId!==e.requestId)return result(SendState.UNKNOWN,['CONTEXT_CHANGED']);
 const changed=delta(e.userMsgBefore,e.userMsgAfter);
 if(changed>0 && e.after?.messageAttributionVerified===true && e.after?.requestFingerprint===e.requestFingerprint && validId(e.requestFingerprint))return result(SendState.CONFIRMED,['ATTRIBUTED_USER_MESSAGE']);
 if(e.after?.generation?.reliable===true&&e.after?.generation?.afterDispatch===true&&e.generatingBefore===false&&e.after?.requestFingerprint===e.requestFingerprint&&validId(e.requestFingerprint))return result(SendState.CONFIRMED,['ATTRIBUTED_GENERATION']);
 return result(SendState.UNKNOWN,[changed>0?'UNATTRIBUTED_USER_MESSAGE':'NO_ATTRIBUTED_CONFIRMATION']);
}
export class SendLedger{
 #entries=new Map();
 begin(id){if(!validId(id))throw Error('ID_REQUIRED');if(this.#entries.has(id))throw Error('SEND_ALREADY_ATTEMPTED');this.#entries.set(id,{state:SendState.UNKNOWN});}
 settle(id,evidence){if(!this.#entries.has(id))throw Error('ID_UNKNOWN');const next=classifySend(evidence);this.#entries.set(id,next);return next;}
 get(id){return this.#entries.get(id)??null;}
}

