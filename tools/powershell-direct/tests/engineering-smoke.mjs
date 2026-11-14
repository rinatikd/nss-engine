// Real local HTTP/MCP smoke, no tunnel and no Windows process execution.
// Starts PowerShellApprovalService on ephemeral 127.0.0.1 port and validates
// discovery, rejection of arbitrary commands and read-only status behavior.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PowerShellApprovalService} from '../service.mjs';

const dir=await mkdtemp(path.join(tmpdir(),'ps-direct-smoke-'));
const svc=new PowerShellApprovalService({
  root:'C:\\Engineering',port:0,
  engineeringWorkspaceRoots:[dir],
  engineeringAuditDirectory:path.join(dir,'audits'),
  engineeringRunner:async()=>{throw Error('UNEXPECTED_EXECUTION')}
});
try{
  await svc.start();
  async function call(method,params){
    const response=await fetch('http://127.0.0.1:'+svc.port+'/mcp',{
      method:'POST',
      headers:{Host:'127.0.0.1:'+svc.port,
        Authorization:'Bearer '+svc.agentToken,'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})
    });
    assert.equal(response.status,200);
    return response.json();
  }
  const list=await call('tools/list',{});
  const tools=list.result.tools.map(x=>x.name);
  assert.ok(tools.includes('powershell_engineering_submit'));
  assert.ok(tools.includes('powershell_engineering_status'));
  assert.ok(tools.includes('powershell_propose'));
  const wrong=await call('tools/call',{
    name:'powershell_engineering_submit',
    arguments:{requestId:'smoke-reject-001',operation:'powershell -Command Remove-Item',
      workspace:dir}
  });
  assert.equal(wrong.result.isError,true);
  assert.equal(svc.namedPending.size,0);
  const onlyRead=await call('tools/call',{
    name:'powershell_engineering_status',
    arguments:{requestId:'smoke-no-job-002'}
  });
  const status=JSON.parse(onlyRead.result.content[0].text);
  assert.equal(status.state,'NOT_FOUND');
  console.log('ENGINEERING_LOCAL_MCP_SMOKE_PASS');
  console.log(JSON.stringify({toolCount:tools.length,engineeringTools:
    tools.filter(n=>n.startsWith('powershell_engineering_')),
    arbitraryCommandRejected:true,productionPortTouched:false}));
}finally{
  await svc.stop();
  await rm(dir,{recursive:true,force:true});
}
