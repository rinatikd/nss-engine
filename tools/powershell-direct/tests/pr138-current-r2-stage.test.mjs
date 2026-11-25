import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const source='C:/Engineering/ChromeBridge-Recovery-Install-20261114/work/PowerShellDirect-PR138-current-release-clean';
const stage='C:/Engineering/PowerShellDirect-Engineering-Lab-R2-PR138-35e69e7';
const git='C:/Program Files/Git/cmd/git.exe';
const node='C:/Program Files/nodejs/node.exe';
const tests=[
 'tools/ai_collaboration/workspace-policy.test.mjs',
 'tools/ai_collaboration/local_test_runner.test.mjs',
 'tools/ai_collaboration/local_job_service.test.mjs',
 'tools/ai_collaboration/engineering-runner.test.mjs',
 'tools/ai_collaboration/local_mcp_dispatch.test.mjs',
 'tools/powershell-direct/tests/service.test.mjs',
 'tools/powershell-direct/tests/named-suites.test.mjs',
 'tools/powershell-direct/tests/engineering.test.mjs'
];
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function tree(base){
 const found=[];
 function visit(dir){
  for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
   const full=path.join(dir,ent.name);
   assert.equal(ent.isSymbolicLink(),false,'reparse/symlink not allowed: '+full);
   if(ent.isDirectory())visit(full);
   else if(ent.isFile())found.push(path.relative(base,full).split(path.sep).join('/'));
   else assert.fail('unsupported entry: '+full);
  }
 }
 visit(base);return found.filter(x=>x!=='source-hashes.json').sort();
}
function tracked(){
 const r=spawnSync(git,['-C',source,'ls-files','--','tools/powershell-direct','tools/ai_collaboration'],{
  cwd:source,encoding:'utf8',timeout:15000,windowsHide:true
 });
 assert.equal(r.status,0,'git inventory failed: '+(r.stderr||r.error||''));
 return r.stdout.split(/\r?\n/).filter(Boolean).sort();
}
test('clean current PR138 stage matches pinned Git tree and SHA-256 manifest exactly',()=>{
 assert.ok(fs.statSync(stage).isDirectory(),'fresh current candidate stage must exist');
 const rows=JSON.parse(fs.readFileSync(path.join(stage,'source-hashes.json'),'utf8').replace(/^\uFEFF/,''));
 assert.ok(Array.isArray(rows)&&rows.length>=17);
 assert.ok(rows.every(x=>typeof x.File==='string'&&/^[0-9a-f]{64}$/i.test(x.Sha256)));
 const names=rows.map(x=>x.File).sort();
 assert.deepEqual(names,tracked(),'manifest must list every Git-tracked source exactly once');
 assert.deepEqual(tree(stage),tracked(),'stage must contain exactly Git-tracked files');
 for(const row of rows){
  assert.match(row.File,/^tools\/(?:powershell-direct|ai_collaboration)\/[a-zA-Z0-9_./ -]+$/);
  assert.equal(hash(path.join(source,row.File)),row.Sha256.toLowerCase(),row.File+' source drift');
  assert.equal(hash(path.join(stage,row.File)),row.Sha256.toLowerCase(),row.File+' stage drift');
 }
});
test('current staged modules pass syntax and regression suite',()=>{
 for(const rel of [
  'tools/powershell-direct/service.mjs',
  'tools/powershell-direct/stack-supervisor.mjs',
  'tools/powershell-direct/runner.mjs',
  'tools/ai_collaboration/engineering-plan.mjs',
  'tools/ai_collaboration/engineering-runner.mjs',
  'tools/ai_collaboration/engineering-mcp.mjs',
  'tools/ai_collaboration/local_job_service.mjs',
  'tools/ai_collaboration/local_test_runner.mjs',
  'tools/ai_collaboration/workspace-policy.mjs'
 ]){
  const r=spawnSync(node,['--check',path.join(stage,rel)],{cwd:stage,encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(r.status,0,rel+': '+(r.stderr||r.error||'syntax failure'));
 }
 const r=spawnSync(node,['--test',...tests],{
  cwd:stage,encoding:'utf8',timeout:180000,maxBuffer:3*1024*1024,windowsHide:true
 });
 assert.equal(r.status,0,(r.stderr||'')+'\n'+(r.stdout||'').slice(-16000));
});