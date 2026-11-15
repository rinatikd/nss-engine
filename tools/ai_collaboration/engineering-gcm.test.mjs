import test from 'node:test';
import assert from 'node:assert/strict';
import {requireTrustedGitCredentialManager} from './engineering-runner.mjs';
import {resolveEngineeringPlan} from './engineering-plan.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('GCM is resolved only from an explicit Git for Windows installation',()=>{
 const paths=[];
 const result=requireTrustedGitCredentialManager({
  exists:p=>{paths.push(p);return true;},
  stat:p=>({isFile:()=>true})
 });
 assert.equal(result,'C:/Program Files/Git/mingw64/bin/git-credential-manager.exe');
 assert.equal(paths.length,1);
 assert.throws(()=>requireTrustedGitCredentialManager({
  exists:()=>false
 }),/TRUSTED_GCM_NOT_INSTALLED/);
 assert.throws(()=>requireTrustedGitCredentialManager({
  exists:()=>true,stat:()=>({isFile:()=>false})
 }),/TRUSTED_GCM_NOT_FILE/);
});

test('guarded pull contains pinned noninteractive GCM and no secrets',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'engineering-gcm-'));
 try{
  const plan=await resolveEngineeringPlan({
   requestId:'gcm-guard-20261115-r1',operation:'git-pull-ff-only',workspace:dir
  },[dir]);
  const args=plan.args;
  assert.ok(args.includes('credential.helper='));
  assert.ok(args.includes('credential.helper=manager'));
  assert.ok(args.includes('credential.interactive=false'));
  assert.ok(args.includes('--ff-only'));
  assert.equal(args.includes('credential.interactive=true'),false);
  assert.equal(args.some(s=>/password|token|bearer|https:\/\/[^/]*@/i.test(s)),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
