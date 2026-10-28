import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server/bridge.mjs';

test('two overlapping sends cannot submit twice to the same agent', {timeout: 8000}, async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-send-race-'));
  fs.writeFileSync(path.join(stateDir,'agents.json'), JSON.stringify({claude:7}));
  const config={agentToken:'race-agent',browserToken:'race-browser'};
  const bridge=createBridge(config,{stateDir,timeout:1500,pollHold:50});
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${bridge.address().port}`;
  const abort=new AbortController();
  let contextCount=0, sends=0;
  let ready;
  const firstContext=new Promise(resolve=>{ready=resolve});
  const post=async(route,body,token=config.agentToken,signal)=>{
    const response=await fetch(base+route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal});
    return response.json();
  };
  const pump=(async()=>{
    while(!abort.signal.aborted){
      const {command}=await post('/bridge/poll',{},config.browserToken,abort.signal);
      if(!command)continue;
      let result;
      if(command.name==='agent_context'){
        contextCount++; ready();
        await new Promise(resolve=>setTimeout(resolve,35));
        result={verified:true,origin:'https://claude.ai',conversationId:'conversation-race-1234'};
      } else if(command.name==='agent_send') {sends++;result={baseline:0,confirmed:true};}
      else throw Error('unexpected '+command.name);
      await post('/bridge/result',{id:command.id,result},config.browserToken,abort.signal);
    }
  })().catch(error=>{if(!abort.signal.aborted)throw error});
  t.after(async()=>{abort.abort();await pump;await new Promise(resolve=>{bridge.close(resolve);bridge.closeAllConnections()});fs.rmSync(stateDir,{recursive:true,force:true})});
  const call=requestId=>post('/mcp',{jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:'agent_send',arguments:{name:'claude',text:'synthetic concurrency test',requestId}}});
  const first=call('race-one');
  await firstContext;
  const second=call('race-two');
  const results=await Promise.all([first,second]);
  assert.equal(sends,1,'only one prompt may be dispatched');
  assert.equal(contextCount,1,'agent must be reserved before context lookup');
  assert.equal(results.filter(r=>r.result.isError===true).length,1);
});

test('binding reserves the agent before awaiting its browser probe', {timeout:5000},async t=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-bind-race-'));
 fs.writeFileSync(path.join(stateDir,'agents.json'),JSON.stringify({claude:7}));
 const config={agentToken:'binding-agent',browserToken:'binding-browser'};
 const bridge=createBridge(config,{stateDir,timeout:1000,pollHold:20});
 await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{bridge.close(resolve);bridge.closeAllConnections();fs.rmSync(stateDir,{recursive:true,force:true})}));
 const base=`http://127.0.0.1:${bridge.address().port}`;
 const post=async(route,body,token=config.agentToken)=>(await fetch(base+route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})).json();
 const call=(name,args)=>post('/mcp',{jsonrpc:'2.0',id:Math.random(),method:'tools/call',params:{name,arguments:args}});
 await post('/bridge/poll',{},config.browserToken);
 const binding=call('agent_bind',{name:'claude',tabId:7});
 const {command}=await post('/bridge/poll',{},config.browserToken);
 assert.equal(command.name,'agent_probe');
 const result=await call('agent_send',{name:'claude',text:'synthetic',requestId:'binding-test'});
 assert.equal(result.result.isError,true);
 assert.match(result.result.content[0].text,/binding or navigation is in progress/);
 await post('/bridge/result',{id:command.id,result:{adapter:'claude',verified:true}},config.browserToken);
 assert.equal((await binding).result.isError,undefined);
});
