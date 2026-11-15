// Read-only startup preflight for the staged Engineering Approval modules.
// Importing service.mjs is safe: it does not bind/listen unless invoked as main.
// No credentials, tunnel run, network access or process/service mutations.
import {pathToFileURL} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
const stage='C:\\Engineering\\PowerShellDirect-Engineering-Lab-R1';
const allowedRoot='C:\\Engineering';
const files=[
 'tools/powershell-direct/service.mjs',
 'tools/powershell-direct/stack-supervisor.mjs',
 'tools/powershell-direct/runner.mjs',
 'tools/ai_collaboration/engineering-plan.mjs',
 'tools/ai_collaboration/engineering-mcp.mjs',
 'tools/ai_collaboration/local_job_service.mjs',
];
const out={check:'ENGINEERING_STAGED_MODULE_PREFLIGHT',platform:process.platform,
  nodeVersion:process.version,checks:[],stackStarted:false,
  productionTouched:false,secretValuesRead:false};
for(const relative of files){
 const full=path.win32.join(stage,relative);
 out.checks.push({file:relative,exists:fs.existsSync(full)});
}
try{
 const servicePath=path.win32.join(stage,'tools/powershell-direct/service.mjs');
 const runnerPath=path.win32.join(stage,'tools/powershell-direct/runner.mjs');
 const {PowerShellApprovalService}=await import(pathToFileURL(servicePath).href);
 const {canonicalWorkspace}=await import(pathToFileURL(runnerPath).href);
 const roots=[
  'C:\\Engineering\\ChromeBridge-Recovery-Install-20261114',
  'C:\\Engineering\\PowerShellDirect-Engineering-Lab-R1'
 ];
 const checked=roots.map(x=>canonicalWorkspace(x,allowedRoot));
 const instance=new PowerShellApprovalService({
  root:allowedRoot,port:0,chatReadonlyEnabled:true,
  engineeringWorkspaceRoots:checked,
  engineeringAuditDirectory:'C:\\Engineering\\PowerShellDirect-Engineering-Audit-R1'
 });
 out.importsOk=true;out.workspaceRootsValid=checked.length===2;
 out.engineeringToolsRegistered=instance.rpc({jsonrpc:'2.0',id:1,method:'tools/list'})
  .result.tools.some(x=>x.name==='powershell_engineering_recent');
 // Instance is neither started nor listening; no keys are exported.
 out.serverListening=instance.server.listening;
 out.result=out.engineeringToolsRegistered?'PASS':'MCP_RECENT_NOT_REGISTERED';
}catch(e){
 out.importsOk=false;out.result='BLOCKED';
 const code=String(e?.code||e?.message||'UNKNOWN');
 // Never emit stack traces, module URLs, arguments or environment.
 const safe=/^(?:ERR_[A-Z0-9_]+|[A-Z][A-Z0-9_]+)$/.test(code)
   ?code:'MODULE_OR_CONFIG_LOAD_FAILED';
 out.errorCode=safe.slice(0,80);
}
process.stdout.write(JSON.stringify(out,null,2)+'\n');
if(out.result!=='PASS')process.exitCode=1;
