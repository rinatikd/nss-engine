import {test} from 'node:test';
import assert from 'node:assert/strict';

test('real UI guard module renders four prerequisite states without a live browser',async()=>{
  const scenarios=[
    {mode:false,lab:false,connected:false,expected:true,revoke:true,reason:'фоновый режим'},
    {mode:true,lab:false,connected:true,expected:true,revoke:false,reason:'экспериментальное'},
    {mode:true,lab:true,connected:false,expected:true,revoke:false,reason:'подключите'},
    {mode:true,lab:true,connected:true,expected:false,revoke:false,reason:'разрешённым'}
  ];
  for (let i=0;i<scenarios.length;i++) {
    const s=scenarios[i];
    const events={};
    const nodes={
      backgroundMode:{checked:s.mode,addEventListener(){}},
      mutationLab:{checked:s.lab,addEventListener(){}},
      backgroundGrantAll:{disabled:false,title:''},
      backgroundRevokeAll:{disabled:true},
      backgroundGrantPrerequisite:{textContent:''}
    };
    globalThis.document={
      hidden:false,
      getElementById:id=>nodes[id],
      addEventListener:(type,fn)=>{events[type]=fn;}
    };
    globalThis.window={addEventListener:(type,fn)=>{events[type]=fn;}};
    globalThis.chrome={
      runtime:{sendMessage:async()=>({connected:s.connected,state:s.connected?'connected':'disconnected'})}
    };
    await import('../extension/control-ui-guard.js?case='+i);
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(nodes.backgroundGrantAll.disabled,s.expected,'grant disabled '+i);
    assert.equal(nodes.backgroundRevokeAll.disabled,s.revoke,'revoke disabled '+i);
    assert.match(nodes.backgroundGrantPrerequisite.textContent,new RegExp(s.reason),'reason '+i);
    events.beforeunload();
  }
});
