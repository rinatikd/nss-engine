// Verify the isolated R2 stage without starting its supervisor or tunnel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const stage='C:/Engineering/PowerShellDirect-Engineering-Lab-R2';
const source='C:/Engineering/ChromeBridge-Recovery-Install-20261114/work/PowerShellDirect-PR138-d9f12c9-release-clean';
const tests=[
 'tools/ai_collaboration/workspace-policy.test.mjs',
 'tools/ai_collaboration/local_test_runner.test.mjs',
 'tools/ai_collaboration/local_job_service.test.mjs',
 'tools/ai_collaboration/engineering-runner.test.mjs',
 'tools/powershell-direct/tests/service.test.mjs',
 'tools/powershell-direct/tests/named-suites.test.mjs',
 'tools/powershell-direct/tests/engineering.test.mjs'
];
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
test('R2 exists and stage manifest matches pinned source, runtime and regression-test bytes',()=>{
 assert.ok(fs.statSync(stage).isDirectory(),'R2 must exist before verification');
 const rows=JSON.parse(fs.readFileSync(path.join(stage,'source-hashes.json'),'utf8').replace(/^\uFEFF/,''));
 assert.ok(Array.isArray(rows)&&rows.length>=17);
 for(const rel of tests){
  assert.ok(rows.some(row=>row.File===rel),'regression test is not hash-pinned: '+rel);
 }
 for(const {File,Sha256} of rows){
  assert.match(File,/^tools\/(?:powershell-direct|ai_collaboration)\/[a-zA-Z0-9_./-]+$/);
  assert.match(Sha256,/^[0-9A-Fa-f]{64}$/);
  assert.equal(hash(path.join(source,File)).toLowerCase(),Sha256.toLowerCase(),File+' source drift');
  assert.equal(hash(path.join(stage,File)).toLowerCase(),Sha256.toLowerCase(),File+' stage drift');
 }
});
test('all staged Node modules pass syntax and selected tests',()=>{
 const node='C:/Program Files/nodejs/node.exe';
 for(const rel of [
  'tools/powershell-direct/service.mjs',
  'tools/powershell-direct/stack-supervisor.mjs',
  'tools/ai_collaboration/engineering-plan.mjs',
  'tools/ai_collaboration/engineering-runner.mjs',
  'tools/ai_collaboration/engineering-mcp.mjs',
  'tools/ai_collaboration/local_job_service.mjs'
 ]){
  const r=spawnSync(node,['--check',path.join(stage,rel)],{cwd:stage,encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(r.status,0,rel+': '+(r.stderr||r.error||'syntax failure'));
 }
 const result=spawnSync(node,['--test',...tests],{
   cwd:stage,encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024,windowsHide:true
 });
 assert.equal(result.status,0,(result.stderr||'')+'\n'+(result.stdout||'').slice(-10000));
});
