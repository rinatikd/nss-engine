// Real binary protocol smoke test for the compiled native messaging host.
// This test is run on Windows AFTER publishing, but BEFORE registry install.
// Never submits "restore"; checks only read-only status and an invalid action.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

const exe=process.argv[2];
if(!exe||!path.isAbsolute(exe))throw Error('ABSOLUTE_HOST_EXE_REQUIRED');

async function one(action){
  return await new Promise((resolve,reject)=>{
    const child=spawn(exe,[],{
      stdio:['pipe','pipe','pipe'],
      shell:false,windowsHide:true,
      env:{PATH:process.env.PATH||'',SystemRoot:process.env.SystemRoot||''}
    });
    let out=Buffer.alloc(0);
    let errs=Buffer.alloc(0);
    const timer=setTimeout(()=>{
      child.kill();reject(Error('NATIVE_HOST_PROTOCOL_TIMEOUT'));
    },25000);
    const cleanup=()=>clearTimeout(timer);
    const payload=Buffer.from(JSON.stringify({action}),'utf8');
    const size=Buffer.alloc(4);size.writeUInt32LE(payload.length);
    child.stdin.end(Buffer.concat([size,payload]));
    child.stdout.on('data',chunk=>{
      out=Buffer.concat([out,chunk]);
      if(out.length>65536){cleanup();child.kill();reject(Error('OUTPUT_TOO_LARGE'));}
    });
    child.stderr.on('data',chunk=>{errs=Buffer.concat([errs,chunk]).subarray(0,4096);});
    child.on('error',e=>{cleanup();reject(e);});
    child.on('close',()=>{
      cleanup();
      try {
        assert.ok(out.length>=4,'Native host returned no framed response');
        const n=out.readUInt32LE(0);
        assert.ok(n>0 && n<=32768);
        assert.equal(out.length,n+4);
        resolve(JSON.parse(out.subarray(4).toString('utf8')));
      }catch(e){reject(e);}
    });
  });
}
const status=await one('status');
assert.equal(status.ok,true,'Read-only status must succeed against staged release');
assert.ok(Array.isArray(status.servers));
assert.ok(Array.isArray(status.connections));
const denied=await one('run-powershell');
assert.equal(denied.ok,false);
assert.equal(denied.error,'ACTION_NOT_ALLOWED');
console.log('NATIVE_MESSAGING_PROTOCOL_SMOKE_PASS: status read and arbitrary command denial');
