import test from 'node:test';
import assert from 'node:assert/strict';
import { pageAction } from '../extension/page.js';

async function inRoute(origin,pathname,search='',hash='',work){
 const prior=globalThis.location;
 globalThis.location={origin,pathname,search,hash};
 try{return await work();}finally{
  if(prior===undefined)delete globalThis.location;
  else globalThis.location=prior;
 }
}
test('Gemini exact /app is a bootstrap context, never a provider-issued chat ID',async()=>{
 await inRoute('https://gemini.google.com','/app','','',async()=>{
  assert.deepEqual(await pageAction('agent_context',{},'https://gemini.google.com'),{
   verified:true,origin:'https://gemini.google.com',conversationId:'GEMINI_NEW_CHAT',bootstrap:true
  });
 });
});
test('existing Gemini /app/id is a real context, not a bootstrap marker',async()=>{
 await inRoute('https://gemini.google.com','/app/12345678-1234-1234-1234-123456789abc','','',async()=>{
  const r=await pageAction('agent_context',{},'https://gemini.google.com');
  assert.equal(r.bootstrap,false);
  assert.equal(r.conversationId,'12345678-1234-1234-1234-123456789abc');
 });
});
test('queries, fragments, non-exact routes and foreign origins cannot bootstrap',async()=>{
 for(const [origin,path,query,hash] of [
  ['https://gemini.google.com','/app/other','',''],
  ['https://gemini.google.com','/app','?mode=other',''],
  ['https://gemini.google.com','/app','','#fragment'],
  ['https://gemini.google.com','/login','',''],
  ['https://evil.example','/app','','']
 ]){
  await inRoute(origin,path,query,hash,async()=>{
   const r=await pageAction('agent_context',{},origin);
   assert.equal(r.bootstrap,false);
   assert.equal(r.verified,false);
  });
 }
});
test('mismatched Gemini bootstrap context rejects before DOM mutation',async()=>{
 await inRoute('https://gemini.google.com','/app','','',async()=>{
  const r=await pageAction('agent_send',{
   allTabsSession:true,controlExpires:Date.now()+10000,
   expectedOrigin:'https://gemini.google.com',
   expectedConversationId:'CLAUDE_NEW_CHAT',
   adapter:{composer:'[contenteditable=true]',send:'button'}
  },'https://gemini.google.com');
  assert.match(r.error,/Conversation changed/);
 });
});
