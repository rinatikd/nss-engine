import test from 'node:test';
import assert from 'node:assert/strict';
import {checkProviderOrigin, classifyProviderPreflight as classify} from './provider-preflight.mjs';
const urls={
 grok:'https://grok.com/',claude:'https://claude.ai/new',
 gemini:'https://gemini.google.com/app',
 kimi:'https://www.kimi.ai/?chat_enter_method=new_chat',
 deepseek:'https://chat.deepseek.com/'
};
const ready=(provider,extra={})=>({
 provider,url:urls[provider],authState:'authenticated',originGranted:true,
 composerVisible:true,composerTextLength:10,sendVisible:true,sendEnabled:true,...extra
});
test('all five exact canonical origins recognized',()=>{
 for(const [provider,url] of Object.entries(urls))assert.equal(checkProviderOrigin(provider,url),true);
 assert.equal(checkProviderOrigin('kimi','https://kimi.ai/'),true);
});
test('rejects lookalike, unknown, insecure and credentialed origins',()=>{
 for(const candidate of [
  'https://kimi.ai.evil.test','https://evil.example/?next=https://kimi.ai',
  'http://www.kimi.ai','https://user:pass@www.kimi.ai',
  'javascript:alert(1)'
 ])assert.equal(checkProviderOrigin('kimi',candidate),false);
 assert.equal(checkProviderOrigin('unknown','https://grok.com'),false);
 assert.equal(checkProviderOrigin('grok','https://x.com/grok'),false);
});
test('login required and unknown auth both block before composer checks',()=>{
 assert.equal(classify(ready('claude',{authState:'login_required'})).state,'GOOGLE_SIGN_IN_OPERATOR_REQUIRED');
 assert.equal(classify(ready('claude',{authState:'unknown'})).state,'AUTH_STATE_NOT_VERIFIED');
});
test('missing site-specific grant never treated as sendable',()=>{
 assert.equal(classify(ready('gemini',{originGranted:false})).state,'SITE_CONTROL_GRANT_REQUIRED');
});
test('empty composer with invisible send is normal: prefill required',()=>{
 assert.equal(classify(ready('gemini',{composerTextLength:0,sendVisible:false,sendEnabled:false})).state,'NEEDS_APPROVED_UNSENT_PREFILL');
});
test('only after typing may missing send become a selector problem',()=>{
 assert.equal(classify(ready('gemini',{sendVisible:false})).state,'SEND_NOT_VISIBLE_AFTER_TYPING');
 assert.equal(classify(ready('gemini',{sendEnabled:false})).state,'SEND_NOT_ENABLED_AFTER_TYPING');
});
test('ready preflight is not permission to send',()=>{
 for(const provider of Object.keys(urls)){
  const r=classify(ready(provider));
  assert.equal(r.state,'READY_FOR_SEPARATELY_APPROVED_SEND');
  assert.equal(r.canSend,false);
 }
});
test('malformed composer length blocks',()=>{
 assert.equal(classify(ready('deepseek',{composerTextLength:-5})).state,'INVALID_COMPOSER_LENGTH');
});
