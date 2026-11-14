// Schema validation for engineering operations. Only structured capabilities.
// No raw CLI command, PowerShell source, arbitrary process signals or file edits.
import {ENGINEERING_OPERATIONS,validateEngineeringRequest} from './engineering-plan.mjs';
export const ENGINEERING_TOOLS=Object.freeze([
 {name:'powershell_engineering_submit',
  description:'Submit Git diagnostics, one Node test, .NET build/test, or read-only PID/port inspection in an allowed workspace. Local approval always required; never runs arbitrary shell.',
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
  powershell_engineering_status:request=>{
   validateEngineeringStatus(request);return service.status(request.requestId);
  }
 });
}
