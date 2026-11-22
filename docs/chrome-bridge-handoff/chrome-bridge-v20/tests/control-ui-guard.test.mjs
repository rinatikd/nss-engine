import {test} from 'node:test';
import assert from 'node:assert/strict';

test('real UI guard module renders four prerequisite states without a live browser',async()=>{
  const scenarios=[
    {mode:false,lab:false,connected:false,grants:0,expected:true,revoke:true,reason:'фоновый режим'},
    {mode:true,lab:false,connected:true,grants:0,expected:true,revoke:true,reason:'экспериментальное'},
    {mode:true,lab:true,connected:false,grants:0,expected:true,revoke:true,reason:'подключите'},
    {mode:true,lab:true,connected:true,grants:0,expected:false,revoke:true,reason:'Управление отключено'},
    {mode:true,lab:true,connected:true,grants:2,expected:true,revoke:false,reason:'Действует временное управление'}
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
      runtime:{sendMessage:async({type})=>type==='background-control-status'
        ? {available:true,backgroundMode:s.mode,mutationEnabled:s.lab,connected:s.connected,
           grantsKnown:true,activeCount:s.grants,grants:[]}
        : {connected:s.connected,state:s.connected?'connected':'disconnected'}},
      storage:{onChanged:{addListener:()=>{}}}
    };
    await import('../extension/control-ui-guard.js?case='+i);
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(nodes.backgroundGrantAll.disabled,s.expected,'grant disabled '+i);
    assert.equal(nodes.backgroundRevokeAll.disabled,s.revoke,'revoke disabled '+i);
    assert.match(nodes.backgroundGrantPrerequisite.textContent,new RegExp(s.reason),'reason '+i);
    events.beforeunload();
  }
});

test('two open control windows converge on coordinator settings after storage changes',async()=>{
  const storageListeners=[];
  const windowEvents={};
  const nodes={
    backgroundMode:{checked:false,addEventListener(){}},
    mutationLab:{checked:false,addEventListener(){}},
    backgroundGrantAll:{disabled:true,title:''},
    backgroundRevokeAll:{disabled:true,title:''},
    backgroundGrantPrerequisite:{textContent:''}
  };
  let canonical={backgroundMode:false,mutationEnabled:false,connected:false,activeCount:0};
  globalThis.document={hidden:false,getElementById:id=>nodes[id],addEventListener(){}};
  globalThis.window={addEventListener:(type,fn)=>{windowEvents[type]=fn;}};
  globalThis.chrome={
    runtime:{sendMessage:async({type})=>type==='background-control-status'
      ? {available:true,...canonical,grantsKnown:true,grants:[]}
      : {connected:canonical.connected,state:canonical.connected?'connected':'disconnected'}},
    storage:{onChanged:{addListener:fn=>storageListeners.push(fn)}}
  };
  await import('../extension/control-ui-guard.js?multiwindow-sync');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(nodes.backgroundMode.checked,false);
  assert.equal(nodes.mutationLab.checked,false);

  canonical={backgroundMode:true,mutationEnabled:true,connected:true,activeCount:1};
  for(const listener of storageListeners)
    listener({bridgeBackgroundMode:{newValue:true},bridgeMutationLabMode:{newValue:true}},'local');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(nodes.backgroundMode.checked,true);
  assert.equal(nodes.mutationLab.checked,true);
  assert.equal(nodes.backgroundRevokeAll.disabled,false);
  assert.equal(nodes.backgroundGrantAll.disabled,true);

  canonical={...canonical,activeCount:0};
  for(const listener of storageListeners)
    listener({bridgeBackgroundControlGrants:{newValue:{}}},'session');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(nodes.backgroundGrantAll.disabled,false);
  assert.equal(nodes.backgroundRevokeAll.disabled,true);
  windowEvents.beforeunload();
});
