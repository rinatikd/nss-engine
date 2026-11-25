import test from 'node:test';import assert from 'node:assert/strict';import {classifySend,SendState,SendLedger} from '../server/send-outcome.mjs';
const base=()=>({dispatched:true,tabId:123,origin:'https://claude.ai',conversationFingerprint:'c'.repeat(64),requestId:'req1',requestFingerprint:'fp1',userMsgBefore:2,userMsgAfter:3,generatingBefore:false,after:{tabId:123,origin:'https://claude.ai',conversationFingerprint:'c'.repeat(64),requestId:'req1',requestFingerprint:'fp1',messageAttributionVerified:true}});
test('attributed user message confirms',()=>assert.equal(classifySend(base()).state,SendState.CONFIRMED));
test('count increase from another user is UNKNOWN',()=>{const e=base();e.after.messageAttributionVerified=false;assert.equal(classifySend(e).state,SendState.UNKNOWN)});
test('wrong tab blocks confirmation',()=>{const e=base();e.after.tabId=124;assert.equal(classifySend(e).state,SendState.UNKNOWN)});
test('wrong origin or conversation blocks confirmation',()=>{const e=base();e.after.origin='https://gemini.google.com';assert.equal(classifySend(e).state,SendState.UNKNOWN);const f=base();f.after.conversationFingerprint='d'.repeat(64);assert.equal(classifySend(f).state,SendState.UNKNOWN)});
test('wrong request blocks confirmation',()=>{const e=base();e.after.requestId='other';assert.equal(classifySend(e).state,SendState.UNKNOWN)});
test('wrong fingerprint blocks confirmation',()=>{const e=base();e.after.requestFingerprint='other';assert.equal(classifySend(e).state,SendState.UNKNOWN)});
test('legacy count-only evidence no longer confirms',()=>assert.equal(classifySend({dispatched:true,userMsgBefore:1,userMsgAfter:2}).state,SendState.UNKNOWN));
test('trusted generation requires correct context and fingerprint',()=>{const e=base();e.userMsgAfter=2;e.after.messageAttributionVerified=false;e.after.generation={reliable:true,afterDispatch:true};assert.equal(classifySend(e).state,SendState.CONFIRMED);e.generatingBefore=true;assert.equal(classifySend(e).state,SendState.UNKNOWN)});
test('cleared composer is insufficient',()=>{const e=base();e.userMsgAfter=2;e.composerLenBefore=8;e.composerLenAfter=0;assert.equal(classifySend(e).state,SendState.UNKNOWN)});
test('unknown result prevents duplicate send same id',()=>{const l=new SendLedger();l.begin('r');l.settle('r',{dispatched:true});assert.throws(()=>l.begin('r'),/SEND_ALREADY_ATTEMPTED/)});
test('explicit no dispatch never confirms',()=>assert.equal(classifySend({dispatched:false}).state,SendState.NOT_PERFORMED));

