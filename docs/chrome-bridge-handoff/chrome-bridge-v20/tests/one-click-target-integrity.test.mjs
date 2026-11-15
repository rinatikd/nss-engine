import test from 'node:test';
import assert from 'node:assert/strict';
import {pageAction} from '../extension/page.js';

async function checkClick({href='https://example.test/safe',
  formAction='',expect,expectedClicked=false}) {
  let clicks=0;
  const element={
    tagName:'A',type:'',name:'',id:'',innerText:'Open report',
    href,form:formAction?{action:formAction}:null,disabled:false,
    getClientRects:()=>[{}],getAttribute:()=>null,
    closest:()=>null,click:()=>{clicks++;}
  };
  const oldDocument=globalThis.document;
  const oldLocation=globalThis.location;
  try {
    globalThis.document={querySelectorAll:selector=>
      selector==='#target'?[element]:[]};
    globalThis.location={
      origin:'https://example.test',pathname:'/docs',search:'',hash:''
    };
    const response=await pageAction('browser_click',{
      selector:'#target',allTabsSession:true,controlExpires:Date.now()+30000,
      expect
    },'https://example.test');
    assert.equal(clicks,expectedClicked?1:0);
    return response;
  } finally {
    if(oldDocument===undefined) delete globalThis.document;
    else globalThis.document=oldDocument;
    if(oldLocation===undefined) delete globalThis.location;
    else globalThis.location=oldLocation;
  }
}

test('one-click accepts unchanged destination after matching preflight',async()=>{
  const r=await checkClick({
    expect:{tag:'a',text:'Open report',
      href:'https://example.test/safe',formAction:''},
    expectedClicked:true
  });
  assert.deepEqual(r,{clicked:true});
});

test('one-click denies href change after permission preflight',async()=>{
  const r=await checkClick({
    href:'https://example.test/changed',
    expect:{tag:'a',text:'Open report',
      href:'https://example.test/safe',formAction:''}
  });
  assert.match(r.error,/Element changed after approval/);
});

test('one-click denies form destination change after preflight',async()=>{
  const r=await checkClick({
    formAction:'https://example.test/changed',
    expect:{tag:'a',text:'Open report',
      href:'https://example.test/safe',formAction:''}
  });
  assert.match(r.error,/Element changed after approval/);
});

test('legacy explicit target checks remain backward compatible',async()=>{
  const r=await checkClick({
    expect:{tag:'a',text:'Open report'},expectedClicked:true
  });
  assert.deepEqual(r,{clicked:true});
});

test('one-click denies visible target change before click',async()=>{
  const r=await checkClick({
    expect:{tag:'a',text:'Other target',
      href:'https://example.test/safe',formAction:''}
  });
  assert.match(r.error,/Element changed after approval/);
});
