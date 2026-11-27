// Schema validation for engineering operations. Only structured capabilities.
// No raw CLI command, PowerShell source, arbitrary process signals or file edits.
import {ENGINEERING_OPERATIONS,validateEngineeringRequest} from './engineering-plan.mjs';
export const ENGINEERING_TOOLS=Object.freeze([
 {name:'powershell_engineering_submit',
  description:'Submit bounded Git diagnostics plus clean-worktree git-pull-ff-only, Node tests, .NET build/test or PID/port inspection in an allowed workspace. Local approval always required; never runs arbitrary shell.',
  inputSchema:{type:'object',additionalProperties:false,
   required:['requestId','operation','workspace'],
   properties:{
    requestId:{type:'string',minLength:8,maxLength:80,pattern:'^[a-zA-Z0-9_-]+$'},
    operation:{type:'string',enum:ENGINEERING_OPERATIONS},
    workspace:{type:'string',minLength:3,maxLength:512},
    target:{type:'string',minLength:1,maxLength:300},
    scriptArgs:{type:'array',maxItems:16,items:{type:'string',maxLength:200}},
    pid:{type:'integer',minimum:1,maximum:2147483647},
    port:{type:'integer',minimum:1024,maximum:65535}
   }}},
 {name:'powershell_engineering_recent',
  description:'List bounded sanitized historical engineering jobs. No execution, approval or retry.',
  inputSchema:{type:'object',additionalProperties:false,properties:{
   limit:{type:'integer',minimum:1,maximum:50}
  }}},
 {name:'powershell_engineering_status',
  description:'Read existing engineering job outcome and clipped logs. Never executes or retries.',
  inputSchema:{type:'object',additionalProperties:false,required:['requestId'],
   properties:{requestId:{type:'string',minLength:8,maxLength:80,pattern:'^[a-zA-Z0-9_-]+$'}}}}
]);
export function validateEngineeringStatus(a){
 if(!a||typeof a!=='object'||Array.isArray(a)||
   Object.keys(a).length!==1||typeof a.requestId!=='string'||
   !/^[a-zA-Z0-9_-]{8,80}$/.test(a.requestId))throw Error('INVALID_STATUS_REQUEST');
 return a;
}
export function createEngineeringHandlers(service){
 if(typeof service?.submit!=='function'||typeof service?.status!=='function')
   throw Error('ENGINEERING_SERVICE_REQUIRED');
 return Object.freeze({
  powershell_engineering_submit:request=>{
   validateEngineeringRequest(request);return service.submit(request);
  },
  powershell_engineering_recent:request=>{
   if(!request||typeof request!=='object'||Array.isArray(request)||
      Object.keys(request).some(key=>key!=='limit'))
     throw Error('INVALID_RECENT_REQUEST');
   const limit=request.limit??20;
   if(!Number.isInteger(limit)||limit<1||limit>50)
     throw Error('INVALID_RECENT_LIMIT');
   if(typeof service.recent!=='function')throw Error('RECENT_UNAVAILABLE');
   return service.recent(limit);
  },
  powershell_engineering_status:request=>{
   validateEngineeringStatus(request);return service.status(request.requestId);
  }
 });
}
