import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eligibleBackgroundControlTabs} from '../extension/control-targets.js';

const origins=Object.freeze({
  'https://claude.ai':'claude',
  'https://gemini.google.com':'gemini',
  'https://chat.deepseek.com':'deepseek'
});
const sites={
  'https://claude.ai':{mode:'chat',adapter:'claude'},
  'https://gemini.google.com':{mode:'chat',adapter:'gemini'},
  'https://chat.deepseek.com':{mode:'chat',adapter:'deepseek'},
  'https://example.com':{mode:'read'},
  'https://grok.com':{mode:'chat',adapter:'grok'},
  'https://spoof.invalid':{mode:'chat',adapter:'claude'}
};
function fixture(tabs,permissions=[]) {
  const queried=[];
  const chrome={
    tabs:{query:async()=>tabs},
    permissions:{contains:async({origins})=>{
      queried.push(origins[0]);
      return permissions.includes(origins[0]);
    }}
  };
  return {chrome,queried};
}
test('global action filters strictly to preapproved chat origins and host permissions',async()=>{
  const {chrome,queried}=fixture([
    {id:1,url:'https://claude.ai/chat/a'},
    {id:2,url:'https://gemini.google.com/app'},
    {id:3,url:'https://chat.deepseek.com/chat'},
    {id:4,url:'https://grok.com/'},
    {id:5,url:'https://example.com/'},
    {id:6,url:'http://127.0.0.1:17481/'},
    {id:7,url:'https://spoof.invalid/'}
  ],['https://claude.ai/*','https://chat.deepseek.com/*','https://grok.com/*']);
  const selected=await eligibleBackgroundControlTabs(chrome,sites,origins);
  assert.deepEqual(selected,[
    {id:1,origin:'https://claude.ai'},
    {id:3,origin:'https://chat.deepseek.com'}
  ]);
  assert.deepEqual(queried,[
    'https://claude.ai/*','https://gemini.google.com/*','https://chat.deepseek.com/*'
  ]);
});
test('global action does not request or create host permissions when none are granted',async()=>{
  const {chrome}=fixture([{id:1,url:'https://claude.ai/chat/a'}]);
  assert.deepEqual(await eligibleBackgroundControlTabs(chrome,sites,origins),[]);
});
test('global action rejects a mismatched site adapter, invalid tab id and malformed URL',async()=>{
  const {chrome}=fixture([
    {id:1,url:'https://claude.ai/chat/a'},
    {id:0,url:'https://gemini.google.com/'},
    {id:2,url:'invalid-url'},
    {id:3,url:'https://chat.deepseek.com/'}
  ],['https://claude.ai/*','https://chat.deepseek.com/*']);
  const configured={...sites,'https://claude.ai':{mode:'chat',adapter:'deepseek'}};
  assert.deepEqual(await eligibleBackgroundControlTabs(chrome,configured,origins),[
    {id:3,origin:'https://chat.deepseek.com'}
  ]);
});
