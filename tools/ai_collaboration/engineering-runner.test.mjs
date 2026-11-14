import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {resolveEngineeringPlan} from './engineering-plan.mjs';
import {runEngineeringPlan} from './engineering-runner.mjs';

async function withPlan(fn){
 const root=await mkdtemp(path.join(tmpdir(),'engineering-exec-'));
 try{
  await writeFile(path.join(root,'probe.js'),'console.log("test")');
  const plan=await resolveEngineeringPlan({
   requestId:'engineering-exec-0001',
   operation:'node-script',workspace:root,target:'probe.js'
  },[root]);
  await fn(plan,root);
 }finally{await rm(root,{recursive:true,force:true});}
}
test('approved plan runs without shell, clamps output, strips secrets',()=>withPlan(async plan=>{
 let seen;
 const result=await runEngineeringPlan(plan,{
  platform:'win32',
  executableCheck:()=>true,
  spawnImpl:(exe,args,options)=>{
   seen={exe,args,options};
   const child=new EventEmitter();
   child.pid=4321;
   child.stdout=new EventEmitter();
   child.stderr=new EventEmitter();
   queueMicrotask(()=>{
    child.stdout.emit('data',Buffer.from('Bearer secret-example-key\n'));
    child.stderr.emit('data',Buffer.from('api_key=not-for-logs'));
    child.emit('close',0,null);
   });
   return child;
  }
 });
 assert.equal(result.state,'FINISHED');
 assert.equal(result.exitCode,0);
 assert.doesNotMatch(result.stdout,/secret-example-key/);
 assert.doesNotMatch(result.stderr,/not-for-logs/);
 assert.equal(seen.options.shell,false);
 assert.equal(seen.options.stdio[0],'ignore');
 assert.equal(Object.hasOwn(seen.options.env,'CONTROL_PLANE_API_KEY'),false);
}));
test('changed source since approval refuses execution',()=>withPlan(async(plan,root)=>{
 await writeFile(path.join(root,'probe.js'),'console.log("MODIFIED")');
 await assert.rejects(runEngineeringPlan(plan,{
  platform:'win32',executableCheck:()=>true,
  spawnImpl:()=>{throw Error('MUST_NOT_EXECUTE')}
 }),/SOURCE_CHANGED_SINCE_APPROVAL/);
}));
test('unrecognized plan cannot spawn a command',async()=>{
 await assert.rejects(runEngineeringPlan({
  requestId:'engineering-exec-unsafe',suite:'engineering',
  executable:'C:/Windows/System32/cmd.exe',args:['/c','del']
 },{platform:'win32',executableCheck:()=>true,
    spawnImpl:()=>{throw Error('MUST_NOT_EXECUTE')}}),/UNRECOGNIZED_PLAN/);
});
