import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTROL_ORIGINS,DISCOVERY_ONLY_ORIGINS,providerForOrigin,ControlGrants}
 from '../extension/permissions.js';
import {DEFAULT_ADAPTERS} from '../extension/adapters.js';

test('Grok/Kimi are discovery-only and never Control origins',()=>{
 for(const [origin,name] of [
  ['https://grok.com','grok'],['https://www.kimi.ai','kimi'],['https://kimi.ai','kimi']
 ]){
  assert.equal(DISCOVERY_ONLY_ORIGINS[origin],name);
  assert.equal(providerForOrigin(origin),name);
  assert.equal(Object.hasOwn(CONTROL_ORIGINS,origin),false);
  const c=new ControlGrants(()=>100);
  c.reset('active');
  assert.throws(()=>c.approve(origin,true,60),/Local approval/);
  assert.throws(()=>c.require(origin),/Control denied/);
 }
});
test('Grok candidate uses unique intended composer and Send selector census',()=>{
 assert.equal(DEFAULT_ADAPTERS.grok.composer,
  'div.tiptap.ProseMirror[contenteditable="true"][role="textbox"]');
 assert.equal(DEFAULT_ADAPTERS.grok.send,'button[data-testid="chat-submit"]');
 assert.equal(DEFAULT_ADAPTERS.grok.reply,'');
});
test('Kimi adapter exists but cannot submit without verified send/reply controls',()=>{
 assert.equal(DEFAULT_ADAPTERS.kimi.origin,'https://www.kimi.ai');
 assert.equal(DEFAULT_ADAPTERS.kimi.send,'');
 assert.equal(DEFAULT_ADAPTERS.kimi.reply,'');
});
