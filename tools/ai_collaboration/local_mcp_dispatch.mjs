// Adapter contract for an MCP host to register *named* local Windows jobs.
// Host wiring is intentionally explicit: this module does not open a server,
// bypass ChatGPT plugin permissions, or provide an approval implementation.
// Service approval MUST come from the trusted local UI bound to requestId+planSha256.
const requestIdSchema={type:'string',minLength:8,maxLength:80,pattern:'^[A-Za-z0-9_-]+$'};
const allowedSuites=[
  'platform-contract','platform-node','nss-portable','platform-provider-preflight',
  'chrome-pr113-node','chrome-pr113-bootstrap','chrome-pr113-build-lab17484'
];

export const NAMED_SUITE_TOOLS=Object.freeze([
  {
    name:'powershell_named_suite_submit',
    description:'Submit one fixed named Windows suite, subject to separate local operator approval. Never accepts a command string or model-authored approval.',
    inputSchema:{
      type:'object',additionalProperties:false,
      required:['requestId','suite','workspace'],
      properties:{
        requestId:requestIdSchema,
        suite:{type:'string',enum:allowedSuites},
        workspace:{type:'string',minLength:3,maxLength:512}
      }
    }
  },
  {
    name:'powershell_named_suite_status',
    description:'Read durable status for a previously submitted named suite; never schedules or retries execution.',
    inputSchema:{
      type:'object',additionalProperties:false,
      required:['requestId'],properties:{requestId:requestIdSchema}
    }
  }
]);

const exactFields=(arg,fields,required)=>{
  if(!arg||typeof arg!=='object'||Array.isArray(arg)||
      Object.keys(arg).some(k=>!fields.includes(k))||
      required.some(k=>typeof arg[k]!=='string')) throw Error('INVALID_TOOL_ARGUMENTS');
};

export function validateNamedSuiteSubmit(args) {
  exactFields(args,['requestId','suite','workspace'],['requestId','suite','workspace']);
  if(!allowedSuites.includes(args.suite))throw Error('SUITE_NOT_ALLOWLISTED');
  if(!/^[A-Za-z0-9_-]{8,80}$/.test(args.requestId))
    throw Error('INVALID_REQUEST_ID');
  if(args.workspace.length<3||args.workspace.length>512)
    throw Error('INVALID_WORKSPACE');
  return args;
}

export function createNamedSuiteHandlers(service) {
  if(typeof service?.submit!=='function'||typeof service?.status!=='function')
    throw Error('NAMED_SUITE_SERVICE_REQUIRED');
  return Object.freeze({
    async powershell_named_suite_submit(args) {
      validateNamedSuiteSubmit(args);
      return service.submit({
        requestId:args.requestId,suite:args.suite,workspace:args.workspace
      });
    },
    async powershell_named_suite_status(args) {
      exactFields(args,['requestId'],['requestId']);
      return service.status(args.requestId);
    }
  });
}
