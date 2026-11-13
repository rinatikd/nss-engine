import test from 'node:test';
import assert from 'node:assert/strict';

// Import with read-only policy set before server module evaluation.
// Isolated query suffix avoids sharing a module instance loaded in other tests.
const previous=process.env.CHROME_BRIDGE_READ_ONLY;
process.env.CHROME_BRIDGE_READ_ONLY='1';
const { createBridge } = await import('../server/bridge.mjs?read-only-stage-test');
if (previous === undefined) delete process.env.CHROME_BRIDGE_READ_ONLY;
else process.env.CHROME_BRIDGE_READ_ONLY=previous;

test('staging server denies direct and indirect writes before dispatch or journal', async t => {
  const server=createBridge({agentToken:'test_agent_token',browserToken:'test_browser_token'});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const address=server.address();
  const call=async(name,args={})=>{
    const response=await fetch('http://127.0.0.1:'+address.port+'/mcp',{
      method:'POST',
      headers:{
        Host:'127.0.0.1:'+address.port,
        Authorization:'Bearer test_agent_token',
        'Content-Type':'application/json'
      },
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
        params:{name,arguments:args}})
    });
    assert.equal(response.status,200);
    return response.json();
  };
  for(const name of ['browser_open','browser_click','browser_fill','agent_send',
      'agent_ask','agent_new_chat','codex_submit','codex_cancel']){
    const result=await call(name);
    assert.equal(result.result?.isError,true,name);
    assert.equal(result.result.content[0].text,'READ_ONLY_STAGE_MUTATION_DENIED');
  }
  const status=await call('browser_status');
  assert.equal(status.result?.isError,undefined);
  const payload=JSON.parse(status.result.content[0].text);
  assert.equal(payload.connected,false);
});
