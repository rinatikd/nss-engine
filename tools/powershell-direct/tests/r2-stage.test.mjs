// Verify the isolated R2 stage without starting its supervisor or tunnel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const stage='C:/Engineering/PowerShellDirect-Engineering-Lab-R2';
const source='C:/Engineering/ChromeBridge-Recovery-Install-20261114/work/PowerShellDirect-PR138-pinned-release-clean';
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
function treeInventory(base){
 const roots=['tools/powershell-direct','tools/ai_collaboration'];
 const files=[];
 for(const root of roots){
  const absoluteRoot=path.join(base,root);
  const visit=directory=>{
   for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const absolute=path.join(directory,entry.name);
    if(entry.isSymbolicLink())throw new Error('REPARSE_POINT_NOT_ALLOWED: '+absolute);
    if(entry.isDirectory())visit(absolute);
    else if(entry.isFile()){
     const relative=path.relative(absoluteRoot,absolute).split(path.sep).join('/');
     files.push(root+'/'+relative);
    }else throw new Error('UNSUPPORTED_STAGE_ENTRY: '+absolute);
   }
  };
  visit(absoluteRoot);
 }
 return files.sort();
}
function trackedInventory(base){
 const git='C:/Program Files/Git/cmd/git.exe';
 const result=spawnSync(git,['-C',base,'ls-files','--',
  'tools/powershell-direct','tools/ai_collaboration'],{
   cwd:base,encoding:'utf8',timeout:15000,windowsHide:true
  });
 assert.equal(result.status,0,'Git tracked-file inventory failed: '+(result.stderr||result.error||''));
 return result.stdout.split(/\r?\n/).filter(Boolean).sort();
}
test('R2 exists and manifest covers every copied pinned runtime and test file',()=>{
 assert.ok(fs.statSync(stage).isDirectory(),'R2 must exist before verification');
 const rows=JSON.parse(fs.readFileSync(path.join(stage,'source-hashes.json'),'utf8').replace(/^\uFEFF/,''));
 assert.ok(Array.isArray(rows)&&rows.length>=17);
 const manifestFiles=rows.map(row=>row.File).sort();
 assert.deepEqual(manifestFiles,trackedInventory(source),'manifest must cover every Git-tracked source file exactly once');
 assert.deepEqual(manifestFiles,treeInventory(stage),'staged tree must contain exactly the manifest files');
 for(const rel of tests){
  assert.ok(manifestFiles.includes(rel),'regression test is not hash-pinned: '+rel);
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
