import test from 'node:test';
import assert from 'node:assert/strict';
import {requireValidBootstrapContext as check} from '../server/bootstrap-context.mjs';
test('Claude and Gemini exact matching markers allowed',()=>{
 assert.equal(check({conversationId:'CLAUDE_NEW_CHAT',bootstrap:true,origin:'https://claude.ai'},'claude').bootstrap,true);
 assert.equal(check({conversationId:'GEMINI_NEW_CHAT',bootstrap:true,origin:'https://gemini.google.com'},'gemini').bootstrap,true);
});
test('marker never crosses agent or origin',()=>{
 for(const [id,origin,agent] of [
  ['CLAUDE_NEW_CHAT','https://claude.ai','gemini'],
  ['GEMINI_NEW_CHAT','https://gemini.google.com','claude'],
  ['GEMINI_NEW_CHAT','https://evil.google.com','gemini'],
  ['CLAUDE_NEW_CHAT','https://claude.ai.evil.test','claude']
 ])assert.throws(()=>check({conversationId:id,bootstrap:true,origin},agent),/SEND_BOOTSTRAP_CONTEXT_INVALID/);
});
test('marker without verified bootstrap and fabricated bootstrap refused',()=>{
 assert.throws(()=>check({conversationId:'CLAUDE_NEW_CHAT',bootstrap:false,origin:'https://claude.ai'},'claude'),/SEND_BOOTSTRAP_CONTEXT_INVALID/);
 assert.throws(()=>check({conversationId:'other_fake_marker',bootstrap:true,origin:'https://claude.ai'},'claude'),/SEND_BOOTSTRAP_CONTEXT_INVALID/);
 assert.throws(()=>check({conversationId:'GEMINI_NEW_CHAT',bootstrap:'true',origin:'https://gemini.google.com'},'gemini'),/SEND_BOOTSTRAP_CONTEXT_INVALID/);
});
test('existing real conversation IDs retain normal send policy',()=>{
 assert.equal(check({conversationId:'12345678-1234-1234-1234-123456789abc',bootstrap:false,origin:'https://claude.ai'},'claude').bootstrap,false);
 assert.equal(check({conversationId:'12345678-1234-1234-1234-123456789abc',origin:'https://gemini.google.com'},'gemini').bootstrap,false);
});

test('prototype names cannot masquerade as bootstrap markers',()=>{
 for(const id of ['constructor','toString','__proto__','hasOwnProperty']) {
  assert.equal(check({conversationId:id,bootstrap:false,origin:'https://claude.ai'},'claude').bootstrap,false);
  assert.throws(()=>check({conversationId:id,bootstrap:true,origin:'https://claude.ai'},'claude'),/SEND_BOOTSTRAP_CONTEXT_INVALID/);
 }
});
