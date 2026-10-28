import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridge} from '../server/bridge.mjs';

test('HTTP MCP validates envelopes before dispatch and acknowledges notifications without content',async t=>{
 const config={agentToken:'protocol-agent',browserToken:'protocol-browser'};
 const bridge=createBridge(config);
 await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{bridge.close(resolve);bridge.closeAllConnections()}));
 const call=body=>fetch(`http://127.0.0.1:${bridge.address().port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${config.agentToken}`,'content-type':'application/json'},body:JSON.stringify(body)});
 for(const body of [{jsonrpc:'1.0',id:1,method:'ping'},{jsonrpc:'2.0',id:1,method:'initialize',params:null},{jsonrpc:'2.0',id:1,method:'initialize',params:[]},[],null]){
  const response=await (await call(body)).json();
  assert.equal(response.error.code,-32600);
 }
 for(const method of ['notifications/initialized','ping','unknown-method','tools/call']){
  const response=await call({jsonrpc:'2.0',method});
  assert.equal(response.status,202);assert.equal(await response.text(),'');
 }
 const result=await (await call({jsonrpc:'2.0',id:'test',method:'initialize',params:{protocolVersion:'2025-06-18'}})).json();
 assert.equal(result.result.protocolVersion,'2025-06-18');
});
