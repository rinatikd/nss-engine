import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { resolveTestPlan, executeTestPlan, terminateProcessTree, trustedExecutable, TaskPolicyError } from './local_test_runner.mjs';

async function withWorkspace(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'platform-runner-test-'));
  try { return await fn(root); } finally { await rm(root, { recursive:true, force:true }); }
}
const requestId = 'local-test-run-001';
const params = (workspace, extras={}) =>
  ({ requestId, suite:'platform-contract', workspace, approved:true, approvedRequestId:requestId, ...extras });

test('approved suite gets a structured immutable command', () => withWorkspace(async root => {
  const plan = await resolveTestPlan(params(root));
  assert.equal(plan.command,'python');
  assert.equal(plan.cwd,root);
  assert.equal(plan.args[0],'-m');
  assert.equal(plan.timeoutMs,60000);
  assert.throws(() => plan.args.push('malicious'), TypeError);
}));

test('unapproved task rejected before plan creation', () => withWorkspace(async root => {
  await assert.rejects(resolveTestPlan(params(root,{approved:false})), /EXPLICIT_APPROVAL_REQUIRED/);
}));

test('approval for another request cannot be reused', () => withWorkspace(async root => {
  await assert.rejects(resolveTestPlan(params(root,{approvedRequestId:'other-request'})), /EXPLICIT_APPROVAL_REQUIRED/);
}));

test('arbitrary shell command cannot be supplied as suite', () => withWorkspace(async root => {
  await assert.rejects(resolveTestPlan(params(root,{suite:'powershell -enc payload'})), /UNKNOWN_TEST_SUITE/);
}));

test('any existing directory can be selected for a single explicit approval', () => withWorkspace(async root => {
  const other = await mkdtemp(path.join(tmpdir(),'platform-runner-other-'));
  try {
    const plan=await resolveTestPlan(params(other));
    assert.equal(plan.cwd,other);
  } finally { await rm(other,{recursive:true,force:true}); }
}));

test('symlink workspace is canonicalized before it is shown for approval', () => withWorkspace(async root => {
  const external = await mkdtemp(path.join(tmpdir(),'platform-runner-external-'));
  try {
    const link=path.join(root,'link');
    await symlink(external,link,'dir');
    const plan=await resolveTestPlan(params(link));
    assert.equal(plan.cwd,external);
  } finally { await rm(external,{recursive:true,force:true}); }
}));

test('non-absolute workspace is refused', async () => {
  await assert.rejects(resolveTestPlan(params('relative/path')), /WORKSPACE_NOT_ABSOLUTE/);
});

test('invalid request ID is refused', () => withWorkspace(async root => {
  await assert.rejects(resolveTestPlan(params(root,{requestId:'x'})), /INVALID_REQUEST_ID/);
}));

test('mutated command plan is rejected before execution', () => withWorkspace(async root => {
  const plan=await resolveTestPlan(params(root));
  await assert.rejects(executeTestPlan({...plan,command:'powershell'}), /PLAN_MODIFIED/);
}));

test('no shell execution, spawn receives fixed args and bounded result', () => withWorkspace(async root => {
  const plan=await resolveTestPlan(params(root));
  let options;
  const mockSpawn=(cmd,args,opts) => {
    options={cmd,args,opts};
    const child=new EventEmitter();
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.kill=()=>{};
    queueMicrotask(() => {child.stdout.emit('data',Buffer.from('PASS'));child.emit('close',0,null);});
    return child;
  };
  const result=await executeTestPlan(plan,{spawnImpl:mockSpawn,trustedExecutableImpl: command => command});
  assert.equal(options.opts.shell,false);
  assert.equal(options.opts.cwd,root);
  assert.equal(options.cmd,'python');
  assert.equal(result.stdout,'PASS');
  assert.equal(result.exitCode,0);
}));

test('output is size-bounded', () => withWorkspace(async root => {
  const plan=await resolveTestPlan(params(root));
  const mockSpawn=() => {
    const child=new EventEmitter();
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.kill=()=>{};
    queueMicrotask(() => {child.stdout.emit('data',Buffer.alloc(100000,65));child.emit('close',0,null);});
    return child;
  };
  const result=await executeTestPlan(plan,{spawnImpl:mockSpawn,trustedExecutableImpl: command => command});
  assert.equal(result.truncated,true);
  assert.ok(Buffer.byteLength(result.stdout)<=65536);
}));

test('PR113 unit suite uses only fixed node --test arguments', () => withWorkspace(async root => {
  const plan=await resolveTestPlan(params(root,{suite:'chrome-pr113-node'}));
  assert.equal(plan.command,'node');
  assert.deepEqual(plan.args,['--test',
    'docs/chrome-bridge-handoff/chrome-bridge-v20/tests/one-click-session.test.mjs']);
  assert.equal(plan.timeoutMs,120000);
}));

test('PR113 lab build has a fixed output folder and cannot accept caller arguments', () => withWorkspace(async root => {
  const plan=await resolveTestPlan(params(root,{suite:'chrome-pr113-build-lab17484'}));
  assert.equal(plan.command,'powershell.exe');
  assert.equal(plan.args.includes('17484'),true);
  assert.equal(plan.args.at(-1),'C:\\Engineering\\ChromeBridge-PR113-E2E-Build-v4');
  await assert.rejects(
    executeTestPlan({...plan,args:[...plan.args,'-Command','Invoke-Expression bad']}),
    /PLAN_MODIFIED/
  );
}));

test('unknown script path injected as suite is refused', () => withWorkspace(async root => {
  await assert.rejects(resolveTestPlan(params(root,{suite:'chrome-pr113-build-lab17484;rm'})),/UNKNOWN_TEST_SUITE/);
}));

test('Windows timeout terminates the target process tree without shell',()=>{
  let issued;
  const child={pid:4242,kill(){throw Error('unexpected direct kill')}};
  const fakeSpawn=(command,args,options)=>{
    issued={command,args,options};
    const killer=new EventEmitter();
    queueMicrotask(()=>killer.emit('close',0));
    return killer;
  };
  const result=terminateProcessTree(child,{platform:'win32',spawnImpl:fakeSpawn});
  assert.equal(result,'tree');
  assert.equal(issued.command,'taskkill.exe');
  assert.deepEqual(issued.args,['/PID','4242','/T','/F']);
  assert.equal(issued.options.shell,false);
});

test('No PID does not issue taskkill against an ambiguous process',()=>{
  let killed=0;
  const child={kill(){killed++;}};
  const result=terminateProcessTree(child,{
    platform:'win32',spawnImpl(){throw Error('should not spawn');}
  });
  assert.equal(result,'direct');
  assert.equal(killed,1);
});

test('Windows Python suite cannot use PATH as an executable source',()=>{
  assert.throws(()=>trustedExecutable('python',{
    platform:'win32',pythonPath:null
  }),/TRUSTED_EXECUTABLE_NOT_CONFIGURED/);
});

test('unsupported Windows program cannot be invoked by PATH lookup',()=>{
  assert.throws(()=>trustedExecutable('cmd.exe',{
    platform:'win32'
  }),/TRUSTED_EXECUTABLE_NOT_CONFIGURED/);
});
