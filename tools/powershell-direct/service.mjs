import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runApproved,validateTask,canonicalWorkspace} from './runner.mjs';
import {createLocalJobService} from '../ai_collaboration/local_job_service.mjs';
import {NAMED_SUITE_TOOLS,createNamedSuiteHandlers,validateNamedSuiteSubmit} from '../ai_collaboration/local_mcp_dispatch.mjs';
import {ENGINEERING_TOOLS,createEngineeringHandlers} from '../ai_collaboration/engineering-mcp.mjs';
import {resolveEngineeringPlan} from '../ai_collaboration/engineering-plan.mjs';
import {runEngineeringPlan} from '../ai_collaboration/engineering-runner.mjs';

const PORT=17486, secret=()=>crypto.randomBytes(32).toString('hex');
// Engineering jobs require local approval; allow a reasonable operator window.
const ENGINEERING_APPROVAL_MS=3*60*1000;
const match=(a,b)=>{const x=Buffer.from(typeof a==='string'?a:''),y=Buffer.from(typeof b==='string'?b:'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clean=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const send=(res,status,obj)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(obj));};

export class PowerShellApprovalService {
 constructor({root,port=PORT,agentToken=secret(),uiToken=secret(),now=Date.now,run=runApproved,workspaceCheck=canonicalWorkspace,chatReadonlyEnabled=false,
   namedWorkspaceRoots=[],namedAuditDirectory=null,namedRunner,
   engineeringWorkspaceRoots=[],engineeringAuditDirectory=null,engineeringRunner=runEngineeringPlan,
   engineeringChatVerifier=null}={}){
  const normalizedRoot=typeof root==='string'?path.win32.normalize(root):'';
  const driveRoot=normalizedRoot&&path.win32.parse(normalizedRoot).root.toLowerCase()===normalizedRoot.toLowerCase();
  const pathSegments=normalizedRoot.toLowerCase().split(path.win32.sep);
  if(!root||!path.win32.isAbsolute(root)||(port!==PORT&&port!==0)||driveRoot||
     normalizedRoot.startsWith('\\\\')||
     pathSegments.some(x=>['windows','system32','program files'].includes(x)))
    throw Error('SAFE_ROOT_AND_PORT_REQUIRED');
  this.root=root;this.port=port;this.agentToken=agentToken;this.uiToken=uiToken;this.now=now;this.run=run;this.workspaceCheck=workspaceCheck;
  this.chatReadonlyEnabled=chatReadonlyEnabled===true;
  if(engineeringChatVerifier!==null&&typeof engineeringChatVerifier!=='function')throw Error('CHAT_APPROVAL_VERIFIER_INVALID');
  this.engineeringChatVerifier=engineeringChatVerifier;
  this.namedPending=new Map();
  this.namedService=null;
  this.namedHandlers=null;
  if(namedWorkspaceRoots.length){
    if(!namedAuditDirectory)throw Error('NAMED_AUDIT_DIR_REQUIRED');
    this.namedService=createLocalJobService({
      approvedWorkspaceRoots:namedWorkspaceRoots,auditDirectory:namedAuditDirectory,
      runner:namedRunner,
      approveRequest:details=>new Promise(resolve=>{
        if(this.namedPending.has(details.requestId)||this.namedPending.size>=32){
          resolve({approved:false,requestId:details.requestId,
            planSha256:details.planSha256});return;
        }
        const expiresAt=Date.now()+90000;
        const timer=setTimeout(()=>{
          this.namedPending.delete(details.requestId);
          resolve({approved:false,requestId:details.requestId,
            planSha256:details.planSha256});
        },90000);
        this.namedPending.set(details.requestId,{...details,resolve,timer,expiresAt});
      })
    });
    this.namedHandlers=createNamedSuiteHandlers(this.namedService);
  }
  this.engineeringService=null;
  this.engineeringHandlers=null;
  if(engineeringWorkspaceRoots.length){
    if(!engineeringAuditDirectory)throw Error('ENGINEERING_AUDIT_DIR_REQUIRED');
    this.engineeringService=createLocalJobService({
      approvedWorkspaceRoots:engineeringWorkspaceRoots,
      auditDirectory:engineeringAuditDirectory,
      resolvePlan:resolveEngineeringPlan,
      runner:engineeringRunner,
      operationName:'engineering-operation',
      approveRequest:details=>new Promise(resolve=>{
        if(this.namedPending.has(details.requestId)||this.namedPending.size>=32){
          resolve({approved:false,requestId:details.requestId,
            planSha256:details.planSha256});return;
        }
        const expiresAt=Date.now()+ENGINEERING_APPROVAL_MS;
        const timer=setTimeout(()=>{
          this.namedPending.delete(details.requestId);
          resolve({approved:false,reason:'APPROVAL_EXPIRED',
            requestId:details.requestId,planSha256:details.planSha256});
        },ENGINEERING_APPROVAL_MS);
        this.namedPending.set(details.requestId,{...details,resolve,timer,expiresAt});
      })
    });
    this.engineeringHandlers=createEngineeringHandlers(this.engineeringService);
  }
  this.jobs=new Map();this.active=null;this.server=http.createServer((req,res)=>this.route(req,res));
 }
 async redeemSignedEngineeringApproval(args){
  if(!this.engineeringChatVerifier||!this.engineeringHandlers)throw Error('CHAT_APPROVAL_NOT_CONFIGURED');
  if(!args||typeof args!=='object'||Array.isArray(args)||
     Object.keys(args).sort().join(',')!=='payload,requestId,signatureBase64Url'||
     !/^[a-zA-Z0-9_-]{8,80}$/.test(args.requestId||'')||
     !args.payload||typeof args.payload!=='object'||
     typeof args.signatureBase64Url!=='string')throw Error('CHAT_APPROVAL_INVALID_REQUEST');
  const pending=this.namedPending.get(args.requestId);
  if(!pending||pending.operation!=='engineering-operation'||
     Date.now()>=pending.expiresAt)throw Error('CHAT_APPROVAL_NOT_PENDING');
  const hash=pending.planSha256;
  const grant=await this.engineeringChatVerifier({
   payload:args.payload,signatureBase64Url:args.signatureBase64Url,
   expectedRequestId:args.requestId,expectedPlanSha256:hash
  });
  if(grant?.approved!==true||grant.source!=='verified_user_attestation'||
     grant.requestId!==args.requestId||grant.planSha256!==hash)
    throw Error('CHAT_APPROVAL_UNVERIFIED');
  const current=this.namedPending.get(args.requestId);
  if(current!==pending||Date.now()>=pending.expiresAt||current.planSha256!==hash)
    throw Error('CHAT_APPROVAL_STALE');
  this.namedPending.delete(args.requestId);
  clearTimeout(pending.timer);
  pending.resolve({approved:true,reason:'SIGNED_CHAT_APPROVAL',
    requestId:args.requestId,planSha256:hash});
  return {requestId:args.requestId,planSha256:hash,
   state:'SIGNED_APPROVAL_ACCEPTED_FOR_PENDING_JOB'};
 }
 propose(args){
  const id=args?.requestId;
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(id))throw Error('INVALID_REQUEST_ID');
  if(this.jobs.has(id))throw Error('DUPLICATE_REQUEST_ID');
  if(this.jobs.size>=32)throw Error('QUEUE_FULL');
  const spec=validateTask(args.task),workspace=this.workspaceCheck(args.workspace,this.root),time=this.now();
  const payload={id,task:args.task,workspace,exe:spec.exe,argv:[...spec.args],issuedAt:time,expiresAt:time+90000};
  const job={payload,sha256:digest(payload),state:'PENDING',result:null};
  this.jobs.set(id,job);
  return {requestId:id,sha256:job.sha256,state:job.state,command:spec.exe+' '+spec.args.join(' '),workspace,expiresAt:payload.expiresAt};
 }
 chatReadonly(a){
  if(!this.chatReadonlyEnabled)throw Error('CHAT_READONLY_DISABLED');
  // ChatGPT plugin must be explicitly configured to Always ask.
  // This service cannot independently verify that the human approved in the host UI.
  // Only the pinned read-only allowlist in runner.mjs may be executed.
  if(this.active)throw Error('ANOTHER_JOB_RUNNING');
  const proposed=this.propose(a);
  const started=this.decide(a.requestId,proposed.sha256,true);
  return {requestId:a.requestId,sha256:proposed.sha256,state:started.state,
    command:proposed.command,workspace:proposed.workspace};
 }
 cancel(id){
  const job=this.jobs.get(id);
  if(!job)throw Error('JOB_NOT_FOUND');
  if(job.state!=='PENDING')throw Error('CANCEL_ONLY_BEFORE_DISPATCH');
  job.state='CANCELLED';
  return {requestId:id,state:job.state};
 }
 status(id){
  const j=this.jobs.get(id);if(!j)throw Error('JOB_NOT_FOUND');
  if(j.state==='PENDING'&&this.now()>=j.payload.expiresAt)j.state='EXPIRED';
  return {requestId:id,sha256:j.sha256,state:j.state,result:j.result};
 }
 decide(id,hash,approved){
  const j=this.jobs.get(id);if(!j)throw Error('JOB_NOT_FOUND');
  if(j.state!=='PENDING')throw Error('NOT_PENDING');
  if(this.now()>=j.payload.expiresAt){j.state='EXPIRED';throw Error('APPROVAL_EXPIRED');}
  if(!match(hash,j.sha256))throw Error('HASH_MISMATCH');
  if(!approved){j.state='DENIED';return {state:j.state};}
  if(this.active)throw Error('ANOTHER_JOB_RUNNING');
  j.state='RUNNING';this.active=id;
  void (async()=>{try{
   j.result=await this.run({task:j.payload.task,workspace:j.payload.workspace,allowedRoot:this.root});
   j.state=j.result.state==='FINISHED'?'FINISHED':'FAILED';
  }catch(e){j.result={reason:e.code||'RUNNER_ERROR'};j.state='FAILED';}finally{this.active=null;}})();
  return {state:'RUNNING'};
 }
 rpc(b){
  const id=b?.id??null;
  if(b?.jsonrpc!=='2.0')return {jsonrpc:'2.0',id,error:{code:-32600,message:'Invalid Request'}};
  if(b.method==='initialize')return {jsonrpc:'2.0',id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'powershell-direct-lab',version:'0.1.0'}}};
  if(b.method==='notifications/initialized')return null;
  if(b.method==='tools/list')return {jsonrpc:'2.0',id,result:{tools:[
   {name:'powershell_propose',description:'Create a pending fixed read-only Windows task, requiring local browser approval before execution.',inputSchema:{type:'object',properties:{requestId:{type:'string'},task:{type:'string',enum:['git-status','git-diff-check','git-branch','git-log','chrome-lab-ports','dotnet-version','node-version','powershell-version']},workspace:{type:'string'}},required:['requestId','task','workspace'],additionalProperties:false}},
   {name:'powershell_cancel',description:'Cancel a pending proposed job without executing anything; cannot cancel an already-running command.',inputSchema:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}},
   {name:'powershell_job',description:'Read the status/result of a proposed PowerShell job; no dispatch.',inputSchema:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}},
   ...(this.namedHandlers ? NAMED_SUITE_TOOLS : []),
   ...(this.engineeringHandlers ? ENGINEERING_TOOLS : []),
   ...(this.engineeringHandlers&&this.engineeringChatVerifier?[{
    name:'powershell_engineering_approve_signed',
    description:'Redeem independently signed operator attestation for one pending engineering job; plain chat approval cannot authorize.',
    annotations:{readOnlyHint:false,destructiveHint:true},
    inputSchema:{type:'object',additionalProperties:false,
      required:['requestId','payload','signatureBase64Url'],
      properties:{
       requestId:{type:'string',minLength:8,maxLength:80,pattern:'^[a-zA-Z0-9_-]+$'},
       payload:{type:'object'},
       signatureBase64Url:{type:'string',minLength:1}
      }
    }
   }]:[]),
   ...(this.chatReadonlyEnabled?[{name:'powershell_chat_readonly',description:'Execute one pinned read-only diagnostic on the Work PC after explicit ChatGPT host approval (plugin permission MUST be Always ask). NO local approval; no arbitrary shell.',inputSchema:{type:'object',properties:{requestId:{type:'string'},task:{type:'string',enum:['git-status','git-diff-check','git-branch','git-log','chrome-lab-ports','dotnet-version','node-version','powershell-version']},workspace:{type:'string'}},required:['requestId','task','workspace'],additionalProperties:false}}]:[])
  ]}};
  if(b.method==='tools/call')try{
   const n=b.params?.name,a=b.params?.arguments||{};
   if(this.engineeringHandlers && n==='powershell_engineering_submit'){
     // Validation occurs synchronously, but the async durable-claim and local
     // approval may not yet have happened. Never claim a new queue entry:
     // duplicates are intentionally rejected by the exclusive audit claim.
     const promise=this.engineeringHandlers.powershell_engineering_submit(a);
     void promise.catch(()=>{});
     return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({
       requestId:a.requestId,state:'SUBMISSION_RECEIVED_STATUS_UNCONFIRMED',
       guidance:'Use powershell_engineering_status to verify durable queue state'
     })}]}};
   }
   if(n==='powershell_engineering_approve_signed'){
     return this.redeemSignedEngineeringApproval(a).then(result=>({
      jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}
     })).catch(e=>({
      jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:
       /^[A-Z0-9_]+$/.test(e.message)?e.message:'CHAT_APPROVAL_DENIED'}]}
     }));
    }
    if(this.engineeringHandlers && n==='powershell_engineering_recent'){
     return Promise.resolve().then(()=>this.engineeringHandlers.powershell_engineering_recent(a))
       .then(result=>({
         jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}
       })).catch(e=>({
         jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:String(e.message||'RECENT_FAILED')}]}
       }));
   }
   if(this.engineeringHandlers && n==='powershell_engineering_status'){
     return this.engineeringHandlers.powershell_engineering_status(a).then(result=>({
       jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}
     })).catch(e=>({
       jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:String(e.message||'STATUS_FAILED')}]}
     }));
   }
   if(this.namedHandlers && n==='powershell_named_suite_submit'){
     validateNamedSuiteSubmit(a);
     // Never hold a remote MCP request open while waiting for local approval.
     // The separate status tool reads durable progress; same ID is not replayed.
     const jobPromise=this.namedHandlers.powershell_named_suite_submit(a);
     void jobPromise.catch(()=>{});
     return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({
       requestId:a.requestId,state:'QUEUED_FOR_LOCAL_APPROVAL'
     })}]}};
   }
   if(this.namedHandlers && n==='powershell_named_suite_status'){
     return this.namedHandlers.powershell_named_suite_status(a).then(result=>({
       jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}
     })).catch(e=>({
       jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:String(e.message||'STATUS_FAILED')}]}
     }));
   }
   const result=n==='powershell_propose'?this.propose(a):n==='powershell_job'?this.status(a.requestId):n==='powershell_cancel'?this.cancel(a.requestId):n==='powershell_chat_readonly'?this.chatReadonly(a):null;
   if(!result)throw Error('TOOL_NOT_FOUND');
   return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}};
  }catch(e){return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:e.message}]}};}
  return {jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}};
 }
 async read(req,limit=8192){
  let size=0;const parts=[];
  for await(const p of req){size+=p.length;if(size>limit)throw Error('BODY_TOO_LARGE');parts.push(p);}
  return Buffer.concat(parts).toString('utf8');
 }
 async route(req,res){
  try{
   if(req.headers.host!=='127.0.0.1:'+this.port)return send(res,403,{error:'HOST_DENIED'});
   const url=new URL(req.url,'http://127.0.0.1:'+this.port);
   if(url.pathname==='/mcp'&&req.method==='POST'){
    if(!match(req.headers.authorization,'Bearer '+this.agentToken))return send(res,401,{error:'AUTH_REQUIRED'});
    const r=await this.rpc(JSON.parse(await this.read(req)||'{}'));
    return r===null?send(res,202,{}):send(res,200,r);
   }
   if(url.pathname==='/approve'&&req.method==='GET'){
    if(!match(url.searchParams.get('key'),this.uiToken))return send(res,403,{error:'UI_AUTH_REQUIRED'});
    const action='/decide?key='+encodeURIComponent(this.uiToken);
    const pending=[...this.jobs.values()].filter(j=>this.status(j.payload.id).state==='PENDING');
    const card=(title,id,hash,workspace,command,expiry,kind='')=>{
      const remaining=Math.max(0,Math.ceil((expiry-Date.now())/1000));
      return '<section class="job"><header><strong>'+clean(title)+'</strong><span class="pill">Ожидает решения</span></header>'+
        '<div class="meta">Задание <code>'+clean(id)+'</code></div>'+
        '<dl><dt>Рабочая папка</dt><dd><code>'+clean(workspace)+'</code></dd>'+
        '<dt>Команда</dt><dd><code>'+clean(command)+'</code></dd>'+
        '<dt>Истекает через</dt><dd>'+clean(String(remaining))+' сек.</dd>'+
        '<dt>SHA256 плана</dt><dd class="hash"><code>'+clean(hash)+'</code></dd></dl>'+
        '<form method="POST" action="'+action+'">'+
        '<input type="hidden" name="kind" value="'+clean(kind)+'">'+
        '<input type="hidden" name="id" value="'+clean(id)+'">'+
        '<input type="hidden" name="sha256" value="'+clean(hash)+'">'+
        '<div class="actions"><button class="allow" name="approved" value="yes">Разрешить один раз</button>'+
        '<button class="deny" name="approved" value="no">Отклонить</button></div></form></section>';
    };
    const rows=pending.map(j=>{
      const p=j.payload;
      return card('Диагностика: '+p.task,p.id,j.sha256,p.workspace,
        p.exe+' '+p.argv.join(' '),p.expiresAt);
    }).join('');
    const namedRows=[...this.namedPending.values()].map(p=>
      card('Инженерная операция: '+(p.suite||'named suite'),p.requestId,p.planSha256,
        p.workspace,(p.risk||'')+' '+(p.command||'')+' '+(p.args||[]).join(' '),
        p.expiresAt,'named')
    ).join('');
    const auditItems=await Promise.all([
      this.engineeringService?.recent?.(15)??[],
      this.namedService?.recent?.(10)??[]
    ]);
    const archived=auditItems.flat().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
      .slice(0,20).map(item=>'<li><code>'+clean(item.requestId)+'</code> — '+
        clean(item.suite)+' — <strong>'+clean(item.state)+'</strong>'+
        (item.reason?' ('+clean(item.reason)+')':'')+'</li>').join('');
    const history=archived?'<section class="job"><h2>Журнал заданий</h2>'+
      '<p class="muted">Только просмотр. Истёкшие и прерванные задания нельзя разрешить повторно — для выполнения нужен новый план.</p>'+
      '<ul>'+archived+'</ul></section>':'';
    // No JavaScript, no auto-approve. The browser refreshes only this authenticated
    // loopback page; every POST still requires a deliberate local button click.
    const css=':root{color-scheme:light}*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;max-width:880px;margin:32px auto;padding:0 18px;color:#17212e;background:#f5f7fa}h1{font-size:25px;margin:0}p{margin:8px 0 20px}.muted{color:#5d6777}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.refresh{padding:9px 14px;border:1px solid #c3cbd7;border-radius:8px;text-decoration:none;background:white;color:#17212e}.job{background:white;border:1px solid #d9e0ea;border-radius:14px;padding:20px;margin:14px 0;box-shadow:0 2px 8px #00000008}.job header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:17px}.pill{font-size:12px;background:#fff3d3;padding:4px 10px;border-radius:20px;color:#785000}.meta{margin:6px 0 14px;color:#546174}dl{display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px 16px;margin:0 0 20px}dt{color:#606b78}dd{margin:0;min-width:0;overflow-wrap:anywhere}code{font:13px/1.55 ui-monospace,Consolas,monospace}.hash{font-size:12px;color:#667382}.actions{display:flex;flex-wrap:wrap;gap:10px}button{cursor:pointer;border-radius:9px;padding:12px 18px;font-weight:650;font-size:14px;border:1px solid #b6c0d0}.allow{color:white;background:#155bd5;border-color:#155bd5}.deny{background:white;color:#9d2b2b;border-color:#d9a3a3}.empty{padding:28px;border:1px dashed #bac5d5;border-radius:12px;text-align:center;background:white}@media(max-width:520px){dl{display:block}dt{margin-top:12px}.job{padding:14px}.actions button{flex:1}}';
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'origin','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"});
    return res.end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="10"><title>Engineering Approval</title><style>'+css+'</style></head><body>'+
      '<div class="top"><h1>Engineering Approval</h1><a class="refresh" href="/approve?key='+encodeURIComponent(this.uiToken)+'">Обновить список</a></div>'+
      '<p class="muted">Локальные запросы Windows. Проверяйте команду и рабочую папку. Автоматического одобрения нет. Список обновляется каждые 10 секунд.</p>'+
      ((rows+namedRows)||'<div class="empty">Нет заданий, ожидающих подтверждения.</div>')+history+'</body></html>');
   }
   if(url.pathname==='/decide'&&req.method==='POST'){
    if(!match(url.searchParams.get('key'),this.uiToken))return send(res,403,{error:'UI_AUTH_REQUIRED'});
    if(req.headers.origin!=='http://127.0.0.1:'+this.port)return send(res,403,{error:'ORIGIN_DENIED'});
    const f=new URLSearchParams(await this.read(req,2048));
    if(f.get('kind')==='named'){
      const p=this.namedPending.get(f.get('id'));
      // A stale browser card (expired, already decided, or from a prior
      // supervisor instance) is not an operator error. Never treat it as a grant.
      if(!p)return send(res,409,{error:'APPROVAL_NO_LONGER_PENDING',
        guidance:'Reload the local approval page. Do not resubmit an expired request.'});
      // Check expiry at decision time, even if timer scheduling is delayed.
      // A late user click can never authorize execution.
      if(Date.now()>=p.expiresAt){
        this.namedPending.delete(p.requestId);
        clearTimeout(p.timer);
        p.resolve({approved:false,reason:'APPROVAL_EXPIRED',
          requestId:p.requestId,planSha256:p.planSha256});
        return send(res,410,{error:'APPROVAL_EXPIRED',
          guidance:'This request expired. A fresh review is required.'});
      }
      if(!match(f.get('sha256'),p.planSha256))
        return send(res,409,{error:'APPROVAL_PLAN_CHANGED',
          guidance:'Reload and inspect the current plan before deciding.'});
      this.namedPending.delete(p.requestId);
      clearTimeout(p.timer);
      const wasApproved=f.get('approved')==='yes';
      p.resolve({approved:wasApproved,reason:wasApproved?'OPERATOR_APPROVED':'OPERATOR_DENIED',
        requestId:p.requestId,planSha256:p.planSha256});
      // Post/Redirect/Get: pressing Refresh must not re-submit the decision.
      res.writeHead(303,{location:'/approve?key='+encodeURIComponent(this.uiToken),
        'cache-control':'no-store','referrer-policy':'origin'});
      return res.end();
    }
    return send(res,200,this.decide(f.get('id'),f.get('sha256'),f.get('approved')==='yes'));
   }
   return send(res,404,{error:'NOT_FOUND'});
  }catch(e){return send(res,400,{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'INVALID_REQUEST'});}
 }
 start(){return new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',()=>{this.port=this.server.address().port;resolve(this);});});}
 stop(){return new Promise(resolve=>this.server.close(resolve));}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=process.argv[2];if(!root)throw Error('USAGE: node service.mjs WINDOWS_ALLOWED_ROOT');
 const svc=new PowerShellApprovalService({root,chatReadonlyEnabled:process.env.PS_DIRECT_CHAT_READONLY_ENABLED==='1'});await svc.start();
 console.error('PS_LAB_READY 127.0.0.1:'+svc.port);
 console.error('LOCAL_APPROVAL_URL http://127.0.0.1:'+svc.port+'/approve?key='+svc.uiToken);
 console.error('MCP_AGENT_TOKEN '+svc.agentToken);
 console.error('Keep both tokens private; never paste in chat or GitHub.');
}
},payload:{type:'object'},
       signatureBase64Url:{type:'string',minLength:86,maxLength:86}}}
   }]:[]),
   ...(this.chatReadonlyEnabled?[{name:'powershell_chat_readonly',description:'Execute one pinned read-only diagnostic on the Work PC after explicit ChatGPT host approval (plugin permission MUST be Always ask). NO local approval; no arbitrary shell.',inputSchema:{type:'object',properties:{requestId:{type:'string'},task:{type:'string',enum:['git-status','git-diff-check','git-branch','git-log','chrome-lab-ports','dotnet-version','node-version','powershell-version']},workspace:{type:'string'}},required:['requestId','task','workspace'],additionalProperties:false}}]:[])
  ]}};
  if(b.method==='tools/call')try{
   const n=b.params?.name,a=b.params?.arguments||{};
   if(this.engineeringHandlers && n==='powershell_engineering_submit'){
     // Validation occurs synchronously, but the async durable-claim and local
     // approval may not yet have happened. Never claim a new queue entry:
     // duplicates are intentionally rejected by the exclusive audit claim.
     const promise=this.engineeringHandlers.powershell_engineering_submit(a);
     void promise.catch(()=>{});
     return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({
       requestId:a.requestId,state:'SUBMISSION_RECEIVED_STATUS_UNCONFIRMED',
       guidance:'Use powershell_engineering_status to verify durable queue state'
     })}]}};
   }
   if(this.engineeringHandlers && n==='powershell_engineering_recent'){
     return Promise.resolve().then(()=>this.engineeringHandlers.powershell_engineering_recent(a))
       .then(result=>({
         jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}
       })).catch(e=>({
         jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:String(e.message||'RECENT_FAILED')}]}
       }));
   }
   if(this.engineeringHandlers && n==='powershell_engineering_status'){
     return this.engineeringHandlers.powershell_engineering_status(a).then(result=>({
       jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}
     })).catch(e=>({
       jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:String(e.message||'STATUS_FAILED')}]}
     }));
   }
   if(this.namedHandlers && n==='powershell_named_suite_submit'){
     validateNamedSuiteSubmit(a);
     // Never hold a remote MCP request open while waiting for local approval.
     // The separate status tool reads durable progress; same ID is not replayed.
     const jobPromise=this.namedHandlers.powershell_named_suite_submit(a);
     void jobPromise.catch(()=>{});
     return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({
       requestId:a.requestId,state:'QUEUED_FOR_LOCAL_APPROVAL'
     })}]}};
   }
   if(this.namedHandlers && n==='powershell_named_suite_status'){
     return this.namedHandlers.powershell_named_suite_status(a).then(result=>({
       jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}
     })).catch(e=>({
       jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:String(e.message||'STATUS_FAILED')}]}
     }));
   }
   const result=n==='powershell_propose'?this.propose(a):n==='powershell_job'?this.status(a.requestId):n==='powershell_cancel'?this.cancel(a.requestId):n==='powershell_chat_readonly'?this.chatReadonly(a):null;
   if(!result)throw Error('TOOL_NOT_FOUND');
   return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}};
  }catch(e){return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:e.message}]}};}
  return {jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}};
 }
 async read(req,limit=8192){
  let size=0;const parts=[];
  for await(const p of req){size+=p.length;if(size>limit)throw Error('BODY_TOO_LARGE');parts.push(p);}
  return Buffer.concat(parts).toString('utf8');
 }
 async route(req,res){
  try{
   if(req.headers.host!=='127.0.0.1:'+this.port)return send(res,403,{error:'HOST_DENIED'});
   const url=new URL(req.url,'http://127.0.0.1:'+this.port);
   if(url.pathname==='/mcp'&&req.method==='POST'){
    if(!match(req.headers.authorization,'Bearer '+this.agentToken))return send(res,401,{error:'AUTH_REQUIRED'});
    const r=await this.rpc(JSON.parse(await this.read(req)||'{}'));
    return r===null?send(res,202,{}):send(res,200,r);
   }
   if(url.pathname==='/approve'&&req.method==='GET'){
    if(!match(url.searchParams.get('key'),this.uiToken))return send(res,403,{error:'UI_AUTH_REQUIRED'});
    const action='/decide?key='+encodeURIComponent(this.uiToken);
    const pending=[...this.jobs.values()].filter(j=>this.status(j.payload.id).state==='PENDING');
    const card=(title,id,hash,workspace,command,expiry,kind='')=>{
      const remaining=Math.max(0,Math.ceil((expiry-Date.now())/1000));
      return '<section class="job"><header><strong>'+clean(title)+'</strong><span class="pill">Ожидает решения</span></header>'+
        '<div class="meta">Задание <code>'+clean(id)+'</code></div>'+
        '<dl><dt>Рабочая папка</dt><dd><code>'+clean(workspace)+'</code></dd>'+
        '<dt>Команда</dt><dd><code>'+clean(command)+'</code></dd>'+
        '<dt>Истекает через</dt><dd>'+clean(String(remaining))+' сек.</dd>'+
        '<dt>SHA256 плана</dt><dd class="hash"><code>'+clean(hash)+'</code></dd></dl>'+
        '<form method="POST" action="'+action+'">'+
        '<input type="hidden" name="kind" value="'+clean(kind)+'">'+
        '<input type="hidden" name="id" value="'+clean(id)+'">'+
        '<input type="hidden" name="sha256" value="'+clean(hash)+'">'+
        '<div class="actions"><button class="allow" name="approved" value="yes">Разрешить один раз</button>'+
        '<button class="deny" name="approved" value="no">Отклонить</button></div></form></section>';
    };
    const rows=pending.map(j=>{
      const p=j.payload;
      return card('Диагностика: '+p.task,p.id,j.sha256,p.workspace,
        p.exe+' '+p.argv.join(' '),p.expiresAt);
    }).join('');
    const namedRows=[...this.namedPending.values()].map(p=>
      card('Инженерная операция: '+(p.suite||'named suite'),p.requestId,p.planSha256,
        p.workspace,(p.risk||'')+' '+(p.command||'')+' '+(p.args||[]).join(' '),
        p.expiresAt,'named')
    ).join('');
    const auditItems=await Promise.all([
      this.engineeringService?.recent?.(15)??[],
      this.namedService?.recent?.(10)??[]
    ]);
    const archived=auditItems.flat().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))
      .slice(0,20).map(item=>'<li><code>'+clean(item.requestId)+'</code> — '+
        clean(item.suite)+' — <strong>'+clean(item.state)+'</strong>'+
        (item.reason?' ('+clean(item.reason)+')':'')+'</li>').join('');
    const history=archived?'<section class="job"><h2>Журнал заданий</h2>'+
      '<p class="muted">Только просмотр. Истёкшие и прерванные задания нельзя разрешить повторно — для выполнения нужен новый план.</p>'+
      '<ul>'+archived+'</ul></section>':'';
    // No JavaScript, no auto-approve. The browser refreshes only this authenticated
    // loopback page; every POST still requires a deliberate local button click.
    const css=':root{color-scheme:light}*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;max-width:880px;margin:32px auto;padding:0 18px;color:#17212e;background:#f5f7fa}h1{font-size:25px;margin:0}p{margin:8px 0 20px}.muted{color:#5d6777}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.refresh{padding:9px 14px;border:1px solid #c3cbd7;border-radius:8px;text-decoration:none;background:white;color:#17212e}.job{background:white;border:1px solid #d9e0ea;border-radius:14px;padding:20px;margin:14px 0;box-shadow:0 2px 8px #00000008}.job header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:17px}.pill{font-size:12px;background:#fff3d3;padding:4px 10px;border-radius:20px;color:#785000}.meta{margin:6px 0 14px;color:#546174}dl{display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px 16px;margin:0 0 20px}dt{color:#606b78}dd{margin:0;min-width:0;overflow-wrap:anywhere}code{font:13px/1.55 ui-monospace,Consolas,monospace}.hash{font-size:12px;color:#667382}.actions{display:flex;flex-wrap:wrap;gap:10px}button{cursor:pointer;border-radius:9px;padding:12px 18px;font-weight:650;font-size:14px;border:1px solid #b6c0d0}.allow{color:white;background:#155bd5;border-color:#155bd5}.deny{background:white;color:#9d2b2b;border-color:#d9a3a3}.empty{padding:28px;border:1px dashed #bac5d5;border-radius:12px;text-align:center;background:white}@media(max-width:520px){dl{display:block}dt{margin-top:12px}.job{padding:14px}.actions button{flex:1}}';
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'origin','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"});
    return res.end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="10"><title>Engineering Approval</title><style>'+css+'</style></head><body>'+
      '<div class="top"><h1>Engineering Approval</h1><a class="refresh" href="/approve?key='+encodeURIComponent(this.uiToken)+'">Обновить список</a></div>'+
      '<p class="muted">Локальные запросы Windows. Проверяйте команду и рабочую папку. Автоматического одобрения нет. Список обновляется каждые 10 секунд.</p>'+
      ((rows+namedRows)||'<div class="empty">Нет заданий, ожидающих подтверждения.</div>')+history+'</body></html>');
   }
   if(url.pathname==='/decide'&&req.method==='POST'){
    if(!match(url.searchParams.get('key'),this.uiToken))return send(res,403,{error:'UI_AUTH_REQUIRED'});
    if(req.headers.origin!=='http://127.0.0.1:'+this.port)return send(res,403,{error:'ORIGIN_DENIED'});
    const f=new URLSearchParams(await this.read(req,2048));
    if(f.get('kind')==='named'){
      const p=this.namedPending.get(f.get('id'));
      // A stale browser card (expired, already decided, or from a prior
      // supervisor instance) is not an operator error. Never treat it as a grant.
      if(!p)return send(res,409,{error:'APPROVAL_NO_LONGER_PENDING',
        guidance:'Reload the local approval page. Do not resubmit an expired request.'});
      // Check expiry at decision time, even if timer scheduling is delayed.
      // A late user click can never authorize execution.
      if(Date.now()>=p.expiresAt){
        this.namedPending.delete(p.requestId);
        clearTimeout(p.timer);
        p.resolve({approved:false,reason:'APPROVAL_EXPIRED',
          requestId:p.requestId,planSha256:p.planSha256});
        return send(res,410,{error:'APPROVAL_EXPIRED',
          guidance:'This request expired. A fresh review is required.'});
      }
      if(!match(f.get('sha256'),p.planSha256))
        return send(res,409,{error:'APPROVAL_PLAN_CHANGED',
          guidance:'Reload and inspect the current plan before deciding.'});
      this.namedPending.delete(p.requestId);
      clearTimeout(p.timer);
      const wasApproved=f.get('approved')==='yes';
      p.resolve({approved:wasApproved,reason:wasApproved?'OPERATOR_APPROVED':'OPERATOR_DENIED',
        requestId:p.requestId,planSha256:p.planSha256});
      // Post/Redirect/Get: pressing Refresh must not re-submit the decision.
      res.writeHead(303,{location:'/approve?key='+encodeURIComponent(this.uiToken),
        'cache-control':'no-store','referrer-policy':'origin'});
      return res.end();
    }
    return send(res,200,this.decide(f.get('id'),f.get('sha256'),f.get('approved')==='yes'));
   }
   return send(res,404,{error:'NOT_FOUND'});
  }catch(e){return send(res,400,{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'INVALID_REQUEST'});}
 }
 start(){return new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',()=>{this.port=this.server.address().port;resolve(this);});});}
 stop(){return new Promise(resolve=>this.server.close(resolve));}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=process.argv[2];if(!root)throw Error('USAGE: node service.mjs WINDOWS_ALLOWED_ROOT');
 const svc=new PowerShellApprovalService({root,chatReadonlyEnabled:process.env.PS_DIRECT_CHAT_READONLY_ENABLED==='1'});await svc.start();
 console.error('PS_LAB_READY 127.0.0.1:'+svc.port);
 console.error('LOCAL_APPROVAL_URL http://127.0.0.1:'+svc.port+'/approve?key='+svc.uiToken);
 console.error('MCP_AGENT_TOKEN '+svc.agentToken);
 console.error('Keep both tokens private; never paste in chat or GitHub.');
}
