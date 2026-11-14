// Operator-attended E2E: genuine executable + real local approval HTTP UI.
// Runs ONLY a read-only Git status on the user-approved workspace. No tunnel,
// no production restart, no outgoing credentials, no engine mutating scripts.
// The operator chooses Deny and Approve once in their local browser.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PowerShellApprovalService} from '../service.mjs';

if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
const workspace=process.argv[2];
if(!workspace||!path.win32.isAbsolute(workspace))throw Error('USAGE: node engineering-live-approval.mjs C:\\Engineering\\<clean-workspace>');
const audit=await mkdtemp(path.join(tmpdir(),'engineering-live-e2e-'));
const service=new PowerShellApprovalService({
  root:'C:\\Engineering',port:0,
  engineeringWorkspaceRoots:[workspace],
  engineeringAuditDirectory:audit
});
async function rpc(name,args){
  const response=await fetch('http://127.0.0.1:'+service.port+'/mcp',{
    method:'POST',
    headers:{authorization:'Bearer '+service.agentToken,'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
      params:{name,arguments:args}})
  });
  assert.equal(response.status,200);
  return await response.json();
}
async function waitFor(id,terminal){
  for(let i=0;i<180;i++){
    const response=await rpc('powershell_engineering_status',{requestId:id});
    const state=JSON.parse(response.result.content[0].text);
    if(terminal.includes(state.state))return state;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error('APPROVAL_OR_EXECUTION_TIMEOUT');
}
try{
  await service.start();
  const url='http://127.0.0.1:'+service.port+'/approve?key='+encodeURIComponent(service.uiToken);
  const cases=[{id:'eng-live-deny-'+process.pid,expect:'DENIED'},
               {id:'eng-live-allow-'+process.pid,expect:'FINISHED'}];
  for(const item of cases){
    const resp=await rpc('powershell_engineering_submit',{
      requestId:item.id,operation:'git-status',workspace
    });
    assert.equal(resp.result.isError,undefined,
      'Submission unexpectedly rejected');
    console.log('LOCAL_APPROVAL_REQUIRED ('+item.expect+')');
    console.log('Open this URL only on the current Windows PC: '+url);
    console.log('Choose '+(item.expect==='DENIED'?'Deny':'Approve once')+
      ' for the displayed git-status request.');
    const result=await waitFor(item.id,[item.expect,'UNKNOWN_OR_FAILED','FAILED','TIMED_OUT']);
    assert.equal(result.state,item.expect,
      'Unexpected result: '+JSON.stringify({state:result.state,errorCode:result.errorCode}));
    if(item.expect==='FINISHED'){
      assert.equal(result.exitCode,0);
      assert.match(result.stdout,/^## /m);
      console.log('LIVE_GIT_STATUS: '+result.stdout.slice(0,300).replace(/[\r\n]+/g,' | '));
    }
    const replay=await rpc('powershell_engineering_submit',{
      requestId:item.id,operation:'git-status',workspace
    });
    assert.equal(replay.result.isError,undefined);
    const after=await rpc('powershell_engineering_status',{requestId:item.id});
    const state=JSON.parse(after.result.content[0].text);
    assert.equal(state.state,item.expect);
    console.log('ONE_SHOT_REPLAY_BLOCKED: '+item.id);
  }
  console.log('ENGINEERING_LOCAL_OPERATOR_E2E_PASS');
}finally{
  await service.stop();
  await rm(audit,{recursive:true,force:true});
}
