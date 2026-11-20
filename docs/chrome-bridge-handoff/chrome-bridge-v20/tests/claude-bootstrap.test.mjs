import test from 'node:test';
import assert from 'node:assert/strict';
import { pageAction } from '../extension/page.js';

async function withRoute(origin, pathname, work) {
  const before = globalThis.location;
  globalThis.location = {origin, pathname, search:'', hash:''};
  try { return await work(); }
  finally {
    if (before === undefined) delete globalThis.location;
    else globalThis.location = before;
  }
}
test('Claude /new yields bootstrap marker but not a fabricated provider chat id',async()=>{
  await withRoute('https://claude.ai','/new',async()=>{
    const r=await pageAction('agent_context',{},'https://claude.ai');
    assert.deepEqual(r,{verified:true,origin:'https://claude.ai',
      conversationId:'CLAUDE_NEW_CHAT',bootstrap:true});
  });
});
test('Claude real /chat/:id is not bootstrap',async()=>{
  await withRoute('https://claude.ai','/chat/12345678-1234-1234-1234-123456789abc',async()=>{
    const r=await pageAction('agent_context',{},'https://claude.ai');
    assert.equal(r.verified,true);
    assert.equal(r.bootstrap,false);
    assert.equal(r.conversationId,'12345678-1234-1234-1234-123456789abc');
  });
});
test('other providers and Claude login route never bootstrap',async()=>{
  for(const [origin,path] of [
    ['https://gemini.google.com','/login'],
    ['https://chat.deepseek.com','/'],
    ['https://claude.ai','/login'],
    ['https://claude.ai','/new/extra']
  ]){
    await withRoute(origin,path,async()=>{
      const r=await pageAction('agent_context',{},origin);
      assert.equal(r.verified,false);
      assert.equal(r.bootstrap,false);
    });
  }
});
test('mismatch in expected first-chat context blocks before any DOM click',async()=>{
  await withRoute('https://claude.ai','/new',async()=>{
    const r=await pageAction('agent_send',{
      allTabsSession:true,controlExpires:Date.now()+10000,
      expectedOrigin:'https://claude.ai',
      expectedConversationId:'UNRELATED_CHAT',
      adapter:{composer:'[contenteditable=true]',send:'button'}
    },'https://claude.ai');
    assert.match(r.error,/Conversation changed/);
  });
});

test('Claude send adapter preserves legacy labels and live-observed test id',async()=>{
  const {DEFAULT_ADAPTERS}=await import('../extension/adapters.js');
  const selector=DEFAULT_ADAPTERS.claude.send;
  assert.match(selector,/chat-input-send/);
  assert.match(selector,/Send message/);
  assert.match(selector,/Send Message/);
  assert.equal(selector.split(',').length,3);
});
