// Bounded engineering diagnostics/build/test plans. No arbitrary shell command.
// Node tests and MSBuild may run project code: always require local approval.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {TaskPolicyError} from './local_test_runner.mjs';
const EXE=Object.freeze({
  git:'C:/Program Files/Git/cmd/git.exe',
  node:'C:/Program Files/nodejs/node.exe',
  dotnet:'C:/Program Files/dotnet/dotnet.exe',
  powershell:'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
});
const timeout=Object.freeze({
  'git-status':20000,'git-diff':30000,'git-log':30000,
  'git-branch':20000,'git-diff-check':30000,'git-pull-ff-only':180000,
  'node-test':180000,'node-script':180000,'powershell-script':180000,
  'dotnet-build':240000,'dotnet-test':240000,
  'process-inspect':20000,'port-inspect':20000
});
const approvedPlans=new WeakSet();
const fail=reason=>{throw new TaskPolicyError(reason);};
const ID=/^[a-zA-Z0-9_-]{8,80}$/;
const SAFE_REL=/^[a-zA-Z0-9_./\\\- ()]+$/;
export const ENGINEERING_OPERATIONS=Object.freeze(Object.keys(timeout));
export function validateEngineeringRequest(a){
  if(!a||typeof a!=='object'||Array.isArray(a))fail('INVALID_REQUEST');
  if(Object.keys(a).some(k=>!['requestId','operation','workspace','target','pid','port','scriptArgs'].includes(k)))
    fail('INVALID_REQUEST_FIELDS');
  if(typeof a.requestId!=='string'||!ID.test(a.requestId))fail('INVALID_REQUEST_ID');
  if(!Object.hasOwn(timeout,a.operation))fail('UNKNOWN_OPERATION');
  if(typeof a.workspace!=='string'||!path.isAbsolute(a.workspace))fail('INVALID_WORKSPACE');
  if(a.target!==undefined){
    if(typeof a.target!=='string'||a.target.length<1||a.target.length>300)
      fail('INVALID_TARGET');
    if(!SAFE_REL.test(a.target)||path.win32.isAbsolute(a.target)||
       path.posix.isAbsolute(a.target)||a.target.includes(':')||
       a.target.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'))
      fail('UNSAFE_TARGET');
    if(['node-test','node-script'].includes(a.operation)&&
       !(a.operation==='node-test'?/\.test\.[cm]?js$/i:/\.[cm]?js$/i).test(a.target))
      fail('NODE_TEST_EXTENSION_REQUIRED');
    if(a.operation==='powershell-script'&&!/\.ps1$/i.test(a.target))fail('POWERSHELL_SCRIPT_REQUIRED');
    if(['dotnet-build','dotnet-test'].includes(a.operation)&&
       !/\.(?:csproj|fsproj|vbproj|sln)$/i.test(a.target))
      fail('DOTNET_PROJECT_REQUIRED');
  }
  if(a.scriptArgs!==undefined){
    if(!['node-script','powershell-script'].includes(a.operation)||
       !Array.isArray(a.scriptArgs)||a.scriptArgs.length>16||
       a.scriptArgs.some(x=>typeof x!=='string'||x.length>200||/[\x00-\x1f]/.test(x)||
         /(?:bearer\s+|(?:token|password|secret|api[_-]?key)\s*[:=])/i.test(x)))
      fail('UNSAFE_SCRIPT_ARGUMENTS');
  }
  if(a.pid!==undefined&&(!Number.isSafeInteger(a.pid)||a.pid<1||a.pid>2147483647))fail('INVALID_PID');
  if(a.port!==undefined&&(!Number.isSafeInteger(a.port)||a.port<1024||a.port>65535))fail('INVALID_PORT');
  if(a.operation==='process-inspect'){
    if(a.pid===undefined||a.port!==undefined||a.target!==undefined)fail('INVALID_OPERATION_ARGUMENTS');
  }else if(a.operation==='port-inspect'){
    if(a.port===undefined||a.pid!==undefined||a.target!==undefined)fail('INVALID_OPERATION_ARGUMENTS');
  }else if(a.port!==undefined||a.pid!==undefined)fail('INVALID_OPERATION_ARGUMENTS');
  if(['node-test','node-script','powershell-script','dotnet-build','dotnet-test'].includes(a.operation)&&!a.target)
    fail('TARGET_REQUIRED');
  if(['git-status','git-diff','git-log','git-branch','git-diff-check','git-pull-ff-only'].includes(a.operation)&&a.target)
    fail('TARGET_NOT_ALLOWED');
  return a;
}
function checkedTarget(root,target,type){
  if(!SAFE_REL.test(target)||path.win32.isAbsolute(target)||
     path.posix.isAbsolute(target)||target.includes(':')||
     target.split(/[\\/]/).some(s=>!s||s==='..'||s==='.'))fail('UNSAFE_TARGET');
  if(type==='node-test'&&!/\.test\.[cm]?js$/i.test(target))fail('NODE_TEST_EXTENSION_REQUIRED');
  if(type==='powershell-script'&&!/\.ps1$/i.test(target))fail('POWERSHELL_SCRIPT_REQUIRED');
  if(type.startsWith('dotnet-')&&!/\.(?:csproj|fsproj|vbproj|sln)$/i.test(target))
    fail('DOTNET_PROJECT_REQUIRED');
  let absolute;try{absolute=fs.realpathSync.native(path.resolve(root,target));}
  catch{fail('TARGET_NOT_FOUND');}
  const relative=path.relative(root,absolute);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||relative==='')
    fail('TARGET_OUTSIDE_WORKSPACE');
  if(!fs.statSync(absolute).isFile())fail('TARGET_NOT_FILE');
  return absolute;
}
export async function resolveEngineeringPlan(request,allowedRoots){
  const a=validateEngineeringRequest(request);
  if(!Array.isArray(allowedRoots)||!allowedRoots.length)fail('WORKSPACES_NOT_CONFIGURED');
  let cwd;
  try{cwd=fs.realpathSync.native(a.workspace);}
  catch{fail('WORKSPACE_NOT_FOUND');}
  if(!fs.statSync(cwd).isDirectory())fail('WORKSPACE_NOT_DIRECTORY');
  if(!allowedRoots.some(root=>{
    try{return fs.realpathSync.native(root).toLowerCase()===cwd.toLowerCase();}
    catch{return false;}
  }))fail('WORKSPACE_NOT_ALLOWLISTED');
  const operation=a.operation;
  let executable,argv;
  switch(operation){
    case 'git-status':
      executable=EXE.git;argv=['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=NUL',
        '--no-pager','status','--short','--branch'];break;
    case 'git-diff':
      executable=EXE.git;argv=['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=NUL',
        '-c','diff.external=','--no-pager','diff','--no-ext-diff','--no-textconv','--'];break;
    case 'git-log':
      executable=EXE.git;argv=['--no-pager','log','-n','20','--format=%h %ad %s','--date=short'];break;
    case 'git-branch':
      executable=EXE.git;argv=['--no-pager','branch','--show-current'];break;
    case 'git-diff-check':
      executable=EXE.git;argv=['--no-optional-locks','-c','core.fsmonitor=false',
        '-c','core.hooksPath=NUL','--no-pager','diff','--check','--'];break;
    case 'git-pull-ff-only':
      // Never accept remote, branch, revision, refspec or Git options from the model.
      // A runtime preflight rejects dirty/detached/untracked worktrees and missing upstream.
      executable=EXE.git;argv=['-c','core.hooksPath=NUL',
        '-c','protocol.ext.allow=never','-c','protocol.file.allow=never',
        // Use already stored Windows GCM credentials even when system/global
        // Git configuration is intentionally disabled by the MCP runner.
        // Noninteractive: no credential material or prompts enter MCP.
        '-c','credential.helper=','-c','credential.helper=manager',
        '-c','credential.interactive=false',
        'pull','--ff-only','--no-rebase','--no-tags','--no-autostash'];break;
    case 'node-test':
      executable=EXE.node;argv=['--test',checkedTarget(cwd,a.target,operation)];break;
    case 'node-script':
      executable=EXE.node;argv=[checkedTarget(cwd,a.target,operation),...(a.scriptArgs||[])];break;
    case 'powershell-script':
      executable=EXE.powershell;argv=['-NoProfile','-NonInteractive','-File',
        checkedTarget(cwd,a.target,operation),...(a.scriptArgs||[])];break;
    case 'dotnet-build':
    case 'dotnet-test':
      executable=EXE.dotnet;argv=[operation==='dotnet-build'?'build':'test',
        checkedTarget(cwd,a.target,operation),'--no-restore','--nologo','-v:quiet'];break;
    case 'process-inspect':
      executable=EXE.powershell;
      argv=['-NoProfile','-NonInteractive','-Command',
        '$id='+a.pid+';$p=Get-CimInstance Win32_Process -Filter "ProcessId=$id";'+
        'if($p){[pscustomobject]@{ProcessId=$p.ProcessId;Name=$p.Name;ParentProcessId=$p.ParentProcessId;ExecutablePath=$p.ExecutablePath}|ConvertTo-Json -Compress}else{Write-Output NOT_FOUND}'];break;
    case 'port-inspect':
      executable=EXE.powershell;
      argv=['-NoProfile','-NonInteractive','-Command',
        '$port='+a.port+';@(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue|'+
        'Select-Object LocalAddress,LocalPort,State,OwningProcess)|ConvertTo-Json -Compress'];break;
    default:fail('UNKNOWN_OPERATION');
  }
  const sourcePath=['node-test','node-script','powershell-script','dotnet-build','dotnet-test'].includes(operation) ?
    (operation==='powershell-script'?argv[3]:operation==='node-test'?argv[1]:operation==='node-script'?argv[0]:argv[1]) : null;
  const sourceSha256=sourcePath?createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'):null;
  const plan=Object.freeze({requestId:a.requestId,suite:'engineering',operation,sourcePath,sourceSha256,
    cwd,executable,args:Object.freeze(argv),timeoutMs:timeout[operation],
    risk:operation==='git-pull-ff-only'?'workspace-write':
      (['node-test','node-script','powershell-script','dotnet-build','dotnet-test'].includes(operation)?'code-execution':'read')});
  approvedPlans.add(plan);
  return plan;
}
export function verifyEngineeringPlan(plan){
  if(!approvedPlans.has(plan)||!Object.isFrozen(plan)||!Object.isFrozen(plan.args))
    fail('UNRECOGNIZED_PLAN');
  return plan;
}
