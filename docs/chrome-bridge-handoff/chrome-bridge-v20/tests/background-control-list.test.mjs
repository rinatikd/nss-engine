import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderBackgroundControlGrants} from '../extension/background-control-list.js';

function node(tag) {
  return {
    tag,children:[],listeners:{},textContent:'',className:'',type:'',disabled:false,
    replaceChildren(...items){this.children=[...items];},
    append(...items){this.children.push(...items);},
    addEventListener(type,fn){this.listeners[type]=fn;}
  };
}

test('per-tab grant list renders validated metadata and local Revoke controls',async()=>{
  const prior=globalThis.document;
  globalThis.document={createElement:tag=>node(tag)};
  try {
    const root=node('root');
    let revoked=[];
    renderBackgroundControlGrants(root,[
      {tabId:41,origin:'https://claude.ai',expiresAt:Date.now()+60000},
      {tabId:42,origin:'https://gemini.google.com',expiresAt:Date.now()+60000},
      {tabId:43,origin:'https://evil.example',expiresAt:Date.now()+60000},
      {tabId:0,origin:'https://claude.ai',expiresAt:Date.now()+60000}
    ],async(tabId)=>{revoked.push(tabId);});
    assert.equal(root.children.length,2);
    assert.match(root.children[0].children[0].textContent,/вкладка 41/);
    const click=root.children[0].children[1].listeners.click;
    click({isTrusted:false});
    await Promise.resolve();
    assert.deepEqual(revoked,[]);
    click({isTrusted:true});
    await Promise.resolve();
    assert.deepEqual(revoked,[41]);
  } finally {
    if(prior===undefined)delete globalThis.document;else globalThis.document=prior;
  }
});

test('empty and unavailable grant lists render safe explanatory text',()=>{
  const prior=globalThis.document;
  globalThis.document={createElement:tag=>node(tag)};
  try {
    const root=node('root');
    renderBackgroundControlGrants(root,[],()=>{});
    assert.match(root.children[0].textContent,/Нет активных разрешений/);
    renderBackgroundControlGrants(root,null,()=>{});
    assert.match(root.children[0].textContent,/недоступен/);
  } finally {
    if(prior===undefined)delete globalThis.document;else globalThis.document=prior;
  }
});
