// Isolated process-lifecycle fault injection for the Engineering cutover design.
// This NEVER launches tunnel-client, contacts Control Plane, binds production ports,
// modifies repo files or invokes Invoke-EngineeringCutover.ps1.
// It tests a real child-process failure and restart using ephemeral loopback ports.
// It is NOT proof that the production PowerShell rollback code works.
import {spawn} from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const SELF=fileURLToPath(import.meta.url);
const PROD_PORTS=new Set([17381,17382,17486,18086,18791]);

async function portOpen(port,timeout=300){
  return new Promise(resolve=>{
    const s=net.connect({host:'127.0.0.1',port});
    let done=false;
    const finish=value=>{
      if(done)return;
      done=true;
      s.destroy();
      resolve(value);
    };
    s.once('connect',()=>finish(true));
    s.once('error',()=>finish(false));
    s.setTimeout(timeout,()=>finish(false));
  });
}
async function unusedEphemeralPort(){
  const server=net.createServer();
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  assert(!PROD_PORTS.has(port),'PRODUCTION_PORT_COLLISION');
  return port;
}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function waitUntil(pred,ms=4000){
  const until=Date.now()+ms;
  do{
    if(await pred())return true;
    await sleep(40);
  }while(Date.now()<until);
  return false;
}
async function childMain(){
  const kind=process.argv[3];
  const port=Number(process.argv[4]);
  assert(Number.isInteger(port)&&port>1024&&!PROD_PORTS.has(port));
  if(kind==='fail'){
    // Deliberate crash before listen; no port ownership.
    process.stderr.write('EXPECTED_STAGED_START_FAILURE\n');
    process.exit(73);
  }
  assert(kind==='original'||kind==='replacement');
  const srv=net.createServer(socket=>{
    // The PowerShell health probe connects and immediately disconnects.
    // Writing a payload after the peer closes can emit an unhandled
    // ECONNRESET/EPIPE on this fixture socket and terminate the Node child.
    // The fixture's health contract is TCP acceptance, not payload exchange.
    socket.on('error',()=>{});
    socket.end();
  });
  srv.on('error',()=>process.exit(72));
  srv.listen(port,'127.0.0.1',()=>{
    process.send?.({event:'ready',role:kind,pid:process.pid,port});
  });
  for(const sig of ['SIGTERM','SIGINT']){
    process.on(sig,()=>srv.close(()=>process.exit(0)));
  }
}
async function spawnService(kind,port){
  const child=spawn(process.execPath,[SELF,'child',kind,String(port)],{
    env:{...process.env},
    stdio:['ignore','pipe','pipe','ipc'],
    windowsHide:true
  });
  const errors=[];
  child.stderr.on('data',b=>errors.push(b.toString()));
  const state=await Promise.race([
    new Promise(resolve=>{
      child.once('message',msg=>resolve({kind:'message',msg}));
      child.once('exit',(code,signal)=>resolve({kind:'exit',code,signal}));
      child.once('error',error=>resolve({kind:'error',message:error.message}));
    }),
    sleep(3500).then(()=>({kind:'timeout'}))
  ]);
  return {child,state,errors};
}
async function stopOwned(proc,port){
  if(!proc)return;
  if(proc.child.exitCode===null && proc.child.signalCode===null){
    proc.child.kill('SIGTERM');
    const ended=await waitUntil(()=>proc.child.exitCode!==null || proc.child.signalCode!==null,2500);
    if(!ended){
      proc.child.kill('SIGKILL');
      await waitUntil(()=>proc.child.exitCode!==null || proc.child.signalCode!==null,2500);
    }
  }
  assert.equal(await waitUntil(async()=>!(await portOpen(port))),true,'PORT_NOT_RELEASED');
}
async function main(){
  let original=null,replacement=null,restored=null;
  const port=await unusedEphemeralPort();
  let refusal=false,restoredHealthy=false,foreignPortsTouched=false;
  try{
    original=await spawnService('original',port);
    assert.equal(original.state.kind,'message','ORIGINAL_NOT_STARTED');
    assert.equal(original.state.msg.role,'original');
    assert.equal(await portOpen(port),true);
    const originalPid=original.child.pid;
    await stopOwned(original,port);
    assert.equal(await portOpen(port),false);
    // The fault occurs AFTER successful old shutdown, BEFORE new readiness.
    replacement=await spawnService('fail',port);
    assert.equal(replacement.state.kind,'exit','FAULT_NOT_OBSERVED');
    assert.equal(replacement.state.code,73,'FAULT_EXIT_CODE_CHANGED');
    refusal=true;
    assert.equal(await portOpen(port),false,'FAILED_REPLACEMENT_OWNS_PORT');
    restored=await spawnService('original',port);
    assert.equal(restored.state.kind,'message','ROLLBACK_ORIGINAL_NOT_RESTARTED');
    restoredHealthy=(restored.state.msg.role==='original'&&
      restored.child.pid!==originalPid&&await portOpen(port));
    assert.equal(restoredHealthy,true,'ROLLBACK_HEALTH_UNCONFIRMED');
    const result={
      Result:'ISOLATED_PROCESS_ROLLBACK_FAULT_INJECTION_PASS',
      Scope:'real Node child-process lifecycle on ephemeral loopback port',
      ReplacedServiceDeliberatelyFailed:refusal,
      OriginalServiceRestartedAndListening:restoredHealthy,
      OriginalProcessPidChanged:true,
      ProductionPortsUsed:false,
      TunnelClientStarted:false,
      ControlPlaneContacted:false,
      PowerShellCutoverTransactionExecuted:false,
      ProductionRollbackVerified:false,
      OtherProcessesTouched:foreignPortsTouched,
      Note:'Supports lifecycle/rollback design only; does not validate production PowerShell rollback or real MCP tunnel.'
    };
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }finally{
    for(const p of [replacement,restored,original]){
      if(p?.child && p.child.exitCode===null && p.child.signalCode===null){
        p.child.kill('SIGTERM');
        await waitUntil(()=>p.child.exitCode!==null||p.child.signalCode!==null,2500);
        if(p.child.exitCode===null&&p.child.signalCode===null)p.child.kill('SIGKILL');
      }
    }
  }
}
if(process.argv[2]==='child'){
  await childMain();
}else{
  await main();
}
