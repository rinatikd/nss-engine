// Read-only import/startup preflight for the current PR138 candidate stage.
// Imports modules and constructs the service object, but never starts/listens,
// creates audit folders, reads credentials, runs a tunnel, or mutates services.
import {pathToFileURL} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const stage='C:\\Engineering\\PowerShellDirect-Engineering-Lab-R2-PR138-35e69e7';
const files=[
 'tools/powershell-direct/service.mjs',
 'tools/powershell-direct/stack-supervisor.mjs',
 'tools/powershell-direct/runner.mjs',
 'tools/ai_collaboration/engineering-plan.mjs',
 'tools/ai_collaboration/engineering-runner.mjs',
 'tools/ai_collaboration/engineering-mcp.mjs',
 'tools/ai_collaboration/local_job_service.mjs',
 'tools/ai_collaboration/workspace-policy.mjs'
];
const out={
 check:'PR138_CURRENT_R2_MODULE_PREFLIGHT',
 candidateSha:'35e69e7e58c7e1b054a0771cabce07cc0c4108df',
 platform:process.platform,nodeVersion:process.version,checks:[],
 serviceStarted:false,serverListening:false,auditFilesWritten:false,
 credentialsRead:false,tunnelTouched:false,productionTouched:false
};
for(const relative of files){
 const full=path.win32.join(stage,relative);
 out.checks.push({file:relative,exists:fs.existsSync(full)});
}
try{
 if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
 if(out.checks.some(x=>!x.exists))throw Error('STAGED_MODULE_MISSING');
 const servicePath=path.win32.join(stage,'tools/powershell-direct/service.mjs');
 const runnerPath=path.win32.join(stage,'tools/powershell-direct/runner.mjs');
 const supervisorPath=path.win32.join(stage,'tools/powershell-direct/stack-supervisor.mjs');
 const planPath=path.win32.join(stage,'tools/ai_collaboration/engineering-plan.mjs');
 const {PowerShellApprovalService}=await import(pathToFileURL(servicePath).href);
 const {canonicalWorkspace}=await import(pathToFileURL(runnerPath).href);
 const canonical=canonicalWorkspace(stage);
 out.workspaceCanonicalized=path.win32.normalize(canonical).toLowerCase()===path.win32.normalize(stage).toLowerCase();
 const supervisor=fs.readFileSync(supervisorPath,'utf8');
 const plan=fs.readFileSync(planPath,'utf8');
 out.noLegacyStaticAllowlist=!/PS_DIRECT_(?:ALLOWED_ROOT|ENGINEERING_WORKSPACES|NAMED_SUITE_WORKSPACES)/.test(supervisor);
 out.canonicalPerJobWorkspacePlan=plan.includes('canonicalUserWorkspace');
 out.workspacePolicyPerJob=out.workspaceCanonicalized&&out.noLegacyStaticAllowlist&&out.canonicalPerJobWorkspacePlan;
 const instance=new PowerShellApprovalService({
  port:0,chatReadonlyEnabled:true,
  engineeringAuditDirectory:path.win32.join(stage,'audit')
 });
 out.importsOk=true;
 const registered=instance.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools.map(x=>x.name);
 out.engineeringSubmitRegistered=registered.includes('powershell_engineering_submit');
 out.engineeringStatusRegistered=registered.includes('powershell_engineering_status');
 out.engineeringRecentRegistered=registered.includes('powershell_engineering_recent');
 out.engineeringToolsRegistered=out.engineeringSubmitRegistered&&out.engineeringStatusRegistered;
 out.serverListening=instance.server.listening;
 out.auditDirectoryCreated=fs.existsSync(path.win32.join(stage,'audit'));
 out.result=out.importsOk&&out.engineeringToolsRegistered&&!out.serverListening&&
  !out.auditDirectoryCreated&&out.workspacePolicyPerJob?'PASS':'CURRENT_R2_RUNTIME_PREFLIGHT_FAILED';
}catch(error){
 out.result='BLOCKED';
 const code=String(error?.code||error?.message||'UNKNOWN');
 out.errorCode=/^(?:ERR_[A-Z0-9_]+|[A-Z][A-Z0-9_]+)$/.test(code)?code.slice(0,80):'MODULE_OR_CONFIG_LOAD_FAILED';
}
process.stdout.write(JSON.stringify(out,null,2)+'\n');
if(out.result!=='PASS')process.exitCode=1;
