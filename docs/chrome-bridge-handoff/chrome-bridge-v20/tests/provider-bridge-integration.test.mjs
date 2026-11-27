import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBridge } from '../server/bridge.mjs';
import { createChromeBridgeProviderTransport } from '../consilium-control-room/consilium/chrome-bridge-provider-adapter.mjs';

test('ProviderTransport adapter completes a synthetic Bridge prepare/commit/fence cycle', { timeout: 15000 }, async () => {
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-bridge-integration-'));
  const config={agentToken:'a'.repeat(64),browserToken:'b'.repeat(64),extensionId:'a'.repeat(32)};
  const server=createBridge(config,{timeout:3000,pollHold:40,stateDir});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const post=(route,body,token=config.agentToken)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
  const rpc=(name,args={})=>post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}).then(r=>r.json());
  const poll=async()=>(await(await post('/bridge/poll',{},config.browserToken)).json()).command;
  let running=true;
  let responderError=null;
  const responder=(async()=>{
    while(running){
      let command;
      try{command=await poll();}catch(error){if(running)responderError=error;break;}
      if(!command)continue;
      let result;
      if(command.name==='agent_probe')result={adapter:'claude',verified:true};
      else if(command.name==='agent_context')result={verified:true,origin:'https://claude.ai',conversationId:'conversation_001'};
      else if(command.name==='provider_prepare')result={prepared:true,requestId:command.args.requestId,preparedId:command.args.preparedId,expiresAt:command.args.expiresAt,payloadHash:command.args.payloadHash,sideEffect:'composer-filled-no-send',clickedSend:false};
      else if(command.name==='provider_commit')result={clickedSend:true,requestId:command.args.requestId,preparedId:command.args.preparedId,payloadHash:command.args.payloadHash,clickedAt:new Date().toISOString(),baseline:0,confirmed:true};
      else throw Error('Unexpected synthetic Bridge command: '+command.name);
      const ack=await post('/bridge/result',{id:command.id,result},config.browserToken);
      assert.equal(ack.status,200);
    }
  })();
  try{
    const bound=await rpc('agent_bind',{name:'claude',tabId:42});
    assert.equal(bound.result.isError,undefined);
    const transport=createChromeBridgeProviderTransport({endpoint:base,agentToken:config.agentToken,timeoutMs:3000});
    const message='Synthetic ProviderTransport integration fixture.';
    const payloadHash=crypto.createHash('sha256').update(message,'utf8').digest('hex');
    const identity={requestId:'request_0001',taskId:'task_000001',providerId:'claude',tabId:42,origin:'https://claude.ai',conversationId:'conversation_001',epoch:7};
    const prepared=await transport.prepare({...identity,message,payloadHash});
    assert.equal(prepared.state,'PREPARED');
    assert.equal(prepared.clickedSend,false);
    assert.ok(prepared.fencingToken);
    const sent=await transport.commit({...identity,preparedId:prepared.preparedId,fencingToken:prepared.fencingToken,payloadHash:prepared.payloadHash});
    assert.equal(sent.state,'SENT');
    assert.equal(sent.clickedSend,true);
    assert.equal((await transport.status(identity)).state,'SENT');
    const stopped=await transport.stop(identity);
    assert.equal(stopped.state,'STOP_AFTER_COMMIT');
    assert.equal(stopped.nextEpoch,8);
    assert.equal(responderError,null);
  }finally{
    running=false;
    await responder;
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(stateDir,{recursive:true,force:true});
  }
});
