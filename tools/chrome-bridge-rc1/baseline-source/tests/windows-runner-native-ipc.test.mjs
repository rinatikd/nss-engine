import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {nativeRequest,wire} from '../native/windows-runner-v07/ipc.mjs';
const native=process.platform==='win32'&&process.env.CHROME_BRIDGE_NATIVE_V07==='1';
const options={skip:!native};
test('v07 request validation (no process or mocks)',()=>{for(const a of [{executable:'cmd.exe'},{op:'codex_submit'},{text:'x'.repeat(1025)},{timeoutMs:0},{signal:{}},[]])assert.throws(()=>nativeRequest(a),/INVALID_REQUEST/);});
test('v07 REAL native LPAC echo and bounded maximum UTF8 payload',options,async()=>{for(const text of ['synthetic ?? $(literal)', 'a'.repeat(1024)]){const r=await nativeRequest({text});assert.equal(r.text,text);assert.equal(r.status,'succeeded');assert.equal(r.empty,true);assert.equal(r.isolated,true);console.log(JSON.stringify(r));}});
test('v07 REAL native cancellation and deadline',options,async()=>{const c=new AbortController();const p=nativeRequest({op:'hold',signal:c.signal});setTimeout(()=>c.abort(),200);assert.equal((await p).status,'cancelled');assert.equal((await nativeRequest({op:'hold',timeoutMs:100})).status,'timed_out');const pre=new AbortController();pre.abort();assert.equal((await nativeRequest({op:'hold',signal:pre.signal})).status,'cancelled');});
test('v07 REAL native unexpected worker death and output flood',options,async()=>{assert.equal((await nativeRequest({op:'crash'})).status,'failed');await assert.rejects(nativeRequest({op:'flood'}));});
function raw(binary,bytes){return new Promise((resolve,reject)=>{const c=spawn(fileURLToPath(new URL(`../native/windows-runner-v07/${binary}`,import.meta.url)),[],{env:{SystemRoot:process.env.SystemRoot,LOCALAPPDATA:process.env.LOCALAPPDATA},stdio:['pipe','pipe','pipe'],windowsHide:true});let log='',out=0;const t=setTimeout(()=>{c.kill();reject(Error('test watchdog'));},8000);c.stderr.on('data',b=>{log+=b;if(log.length>4096)c.kill();});c.stdout.on('data',b=>{out+=b.length;});c.stdin.on('error',()=>{});c.stdin.end(bytes);c.on('error',reject);c.on('close',code=>{clearTimeout(t);resolve({code,log,out});});});}
test('v07 REAL native rejects malformed, oversized, truncated and wrong-job cancellation',options,async()=>{const id=randomUUID();for(const b of [wire('bad'),Buffer.from([0,0,16,1]),Buffer.from([0,0,0,4,97]),wire(`${id}|echo|0|`),wire(`${id}|echo|100|0`),Buffer.concat([wire(`${id}|hold|1000|`),wire(`cancel|${randomUUID()}`)])]){const r=await raw('broker.exe',b);assert.notEqual(r.code,0);assert.equal(r.out,0);console.log(r);}});
test('v07 REAL unauthorized worker invocation without inherited protocol handles',options,async()=>{const r=await raw('worker.exe',Buffer.alloc(0));assert.equal(r.code,8);assert.equal(r.out,0);});
test('v07 distinct Windows principal attempts IPC open / handle duplication',{skip:'Requires separately provisioned test principal; no accounts or host security settings changed'},()=>{});

test('v07 REAL supervisor crash kills LPAC worker via Job Object',options,async()=>{
 const c=spawn(fileURLToPath(new URL('../native/windows-runner-v07/broker.exe',import.meta.url)),[],{env:{SystemRoot:process.env.SystemRoot,LOCALAPPDATA:process.env.LOCALAPPDATA},stdio:['pipe','pipe','pipe'],windowsHide:true});
 let log='';c.stdin.on('error',()=>{});c.stdout.resume();
 const closed=new Promise(resolve=>c.once('close',resolve));
 const pid=await new Promise((resolve,reject)=>{const t=setTimeout(()=>{c.kill();reject(Error('no verified worker'));},3000);c.stderr.on('data',b=>{log+=b;const m=/verified_pid=(\d+)/.exec(log);if(m){clearTimeout(t);resolve(Number(m[1]));}});c.once('error',reject);c.stdin.write(wire(`${randomUUID()}|hold|5000|`));});
 c.kill();await closed;
 let gone=false;for(let i=0;i<100;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){gone=true;break;}throw e;}await new Promise(r=>setTimeout(r,20));}
 assert.equal(gone,true,'LPAC worker must no longer exist');const suffix=/fixture_suffix=([0-9]+-[0-9]+)/.exec(log)?.[1];assert.ok(suffix);await promisify(execFile)(fileURLToPath(new URL('../native/windows-runner-v07/broker.exe',import.meta.url)),['--cleanup-crash',suffix],{env:{SystemRoot:process.env.SystemRoot,LOCALAPPDATA:process.env.LOCALAPPDATA},windowsHide:true});console.log({supervisorKilled:true,workerPid:pid,workerGone:gone});
});
