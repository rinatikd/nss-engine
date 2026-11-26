import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runApproved,validateExecutionSpec,canonicalWorkspace} from './runner.mjs';

const PORT=17486;
const secret=()=>crypto.randomBytes(32).toString('hex');
const match=(a,b)=>{const x=Buffer.from(typeof a==='string'?a:''),y=Buffer.from(typeof b==='string'?b:'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const send=(res,status,obj)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(obj));};

export class PowerShellApprovalService {
 constructor({root,port=PORT,agentToken=secret(),uiToken=secret(),now=Date.now,run=runApproved,workspaceCheck=canonicalWorkspace}={}){
  const normalized=typeof root==='string'?path.win32.normalize(root):'';
  if(!root||!path.win32.isAbsolute(root)||normalized===path.win32.parse(normalized).root||
    normalized.startsWith('\\\\')||port!==PORT&&port!==0)throw Error('SAFE_ROOT_AND_PORT_REQUIRED');
  this.root=root;this.port=port;this.agentToken=agentToken;this.uiToken=uiToken;
  this.now=now;this.run=run;this.workspaceCheck=workspaceCheck;this.jobs=new Map();this.active=null;
  this.server=http.createServer((req,res)=>this.route(req,res));
 }
 propose(args){
  const id=args?.requestId;
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(id))throw Error('INVALID_REQUEST_ID');
  if(this.jobs.has(id))throw Error('DUPLICATE_REQUEST_ID');
  if(this.jobs.size>=32){
   for(const [oldId,oldJob] of this.jobs){
    if(oldJob.state!=='PENDING'&&oldJob.state!=='RUNNING')this.jobs.delete(oldId);
    if(this.jobs.size<32)break;
   }
  }
  if(this.jobs.size>=32)throw Error('QUEUE_FULL');
  const spec=validateExecutionSpec(args);
  const workspace=this.workspaceCheck(args.workspace,this.root),time=this.now();
  const payload={id,spec,workspace,issuedAt:time,expiresAt:time+90000};
  const job={payload,sha256:digest(payload),state:'PENDING',result:null};
  this.jobs.set(id,job);
  return {requestId:id,sha256:job.sha256,state:job.state,executable:spec.executable,args:spec.args,
    purpose:spec.purpose,riskAssessment:spec.riskAssessment,workspace,timeoutMs:spec.timeoutMs,expiresAt:payload.expiresAt};
 }
 cancel(id){
  const job=this.jobs.get(id);if(!job)throw Error('JOB_NOT_FOUND');
  if(job.state!=='PENDING')throw Error('CANCEL_ONLY_BEFORE_DISPATCH');
  job.state='CANCELLED';return {requestId:id,state:job.state};
 }
 status(id){
  const job=this.jobs.get(id);if(!job)throw Error('JOB_NOT_FOUND');
  if(job.state==='PENDING'&&this.now()>=job.payload.expiresAt)job.state='EXPIRED';
  return {requestId:id,sha256:job.sha256,state:job.state,result:job.result};
 }
 decide(id,hash,approved){
  const job=this.jobs.get(id);if(!job)throw Error('JOB_NOT_FOUND');
  if(job.state!=='PENDING')throw Error('NOT_PENDING');
  if(this.now()>=job.payload.expiresAt){job.state='EXPIRED';throw Error('APPROVAL_EXPIRED');}
  if(!match(hash,job.sha256))throw Error('HASH_MISMATCH');
  if(!approved){job.state='DENIED';return {state:job.state};}
  if(this.active)throw Error('ANOTHER_JOB_RUNNING');
  job.state='RUNNING';this.active=id;
  void (async()=>{try{
    job.result=await this.run({spec:job.payload.spec,workspace:job.payload.workspace});
    job.state=job.result.state==='FINISHED'&&job.result.exitCode===0?'FINISHED':'FAILED';
   }catch(e){job.result={reason:/^[A-Z0-9_]+$/.test(e.message)?e.message:e.code||'RUNNER_ERROR'};job.state='FAILED';}
   finally{this.active=null;}
  })();
  return {state:'RUNNING'};
 }
 rpc(message){
  const id=message?.id??null;
  if(message?.jsonrpc!=='2.0')return {jsonrpc:'2.0',id,error:{code:-32600,message:'Invalid Request'}};
  if(message.method==='initialize')return {jsonrpc:'2.0',id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'powershell-direct',version:'0.3.0'}}};
  if(message.method==='notifications/initialized')return null;
  if(message.method==='tools/list')return {jsonrpc:'2.0',id,result:{tools:[
   {name:'powershell_propose',description:'Submit an exact executable path, argument list, workspace, purpose and risk assessment for one-time local approval. Nothing runs until the operator approves locally.',inputSchema:{type:'object',properties:{
    requestId:{type:'string',minLength:8,maxLength:80},executable:{type:'string'},args:{type:'array',items:{type:'string'},maxItems:128},
    workspace:{type:'string'},purpose:{type:'string',maxLength:4000},riskAssessment:{type:'string',maxLength:4000},timeoutMs:{type:'integer',minimum:1000,maximum:600000}
   },required:['requestId','executable','args','workspace','purpose','riskAssessment'],additionalProperties:false}},
   {name:'powershell_cancel',description:'Cancel a pending execution proposal; does not stop an already running process.',inputSchema:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}},
   {name:'powershell_job',description:'Read the state and result of a proposed execution.',inputSchema:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}}
  ]}};
  if(message.method==='tools/call')try{
   const name=message.params?.name,args=message.params?.arguments||{};
   const result=name==='powershell_propose'?this.propose(args):name==='powershell_job'?this.status(args.requestId):name==='powershell_cancel'?this.cancel(args.requestId):null;
   if(!result)throw Error('TOOL_NOT_FOUND');
   return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}};
  }catch(e){return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:e.message}]}};}
  return {jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}};
 }
 async read(req,limit=131072){
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('BODY_TOO_LARGE');chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
 }
 async route(req,res){
  try{
   if(req.headers.host!=='127.0.0.1:'+this.port)return send(res,403,{error:'HOST_DENIED'});
   const url=new URL(req.url,'http://127.0.0.1:'+this.port);
   if(url.pathname==='/mcp'&&req.method==='POST'){
    if(!match(req.headers.authorization,'Bearer '+this.agentToken))return send(res,401,{error:'AUTH_REQUIRED'});
    const response=this.rpc(JSON.parse(await this.read(req)||'{}'));
    return response===null?send(res,202,{}):send(res,200,response);
   }
   if(url.pathname==='/approve'&&req.method==='GET'){
    if(!match(req.headers.authorization,'Bearer '+this.uiToken))return send(res,403,{error:'UI_AUTH_REQUIRED'});
    const pending=[...this.jobs.values()].filter(j=>this.status(j.payload.id).state==='PENDING');
    const rows=pending.map(j=>{
     const p=j.payload;
     const command=esc(JSON.stringify({executable:p.spec.executable,args:p.spec.args},null,2));
     return '<section><h3>'+esc(p.spec.purpose)+'</h3><p><b>Риск:</b> '+esc(p.spec.riskAssessment)+'</p><p><b>Рабочая папка:</b> '+esc(p.workspace)+'</p><p><b>Точная программа и массив аргументов (JSON):</b><pre><code>'+command+'</code></pre></p><p><b>Тайм-аут:</b> '+p.spec.timeoutMs+' мс</p><p><b>SHA-256:</b> <code>'+esc(j.sha256)+'</code></p><form method="POST" action="decide"><input type="hidden" name="id" value="'+esc(p.id)+'"><input type="hidden" name="sha256" value="'+esc(j.sha256)+'"><button name="approved" value="yes">Approve once</button> <button name="approved" value="no">Deny</button></form></section><hr>';
    }).join('');
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
    return res.end('<!doctype html><html><meta charset="utf-8"><h2>Локальное подтверждение PowerShell Direct</h2><p>Проверь назначение, риски, папку и точную команду. Подтверждай только согласованное действие.</p>'+(rows||'<p>Нет ожидающих запросов.</p>')+'</html>');
   }
   if(url.pathname==='/decide'&&req.method==='POST'){
    if(!match(req.headers.authorization,'Bearer '+this.uiToken))return send(res,403,{error:'UI_AUTH_REQUIRED'});
    if(req.headers.origin!=='http://127.0.0.1:'+this.port)return send(res,403,{error:'ORIGIN_DENIED'});
    const form=new URLSearchParams(await this.read(req,2048));
    return send(res,200,this.decide(form.get('id'),form.get('sha256'),form.get('approved')==='yes'));
   }
   return send(res,404,{error:'NOT_FOUND'});
  }catch(e){return send(res,400,{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'INVALID_REQUEST'});}
 }
 start(){return new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',()=>{this.port=this.server.address().port;resolve(this);});});}
 stop(){return new Promise(resolve=>this.server.close(resolve));}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 console.error('SUPERVISOR_REQUIRED: start stack-supervisor.mjs so local approval proxy is available.');
 process.exitCode=1;
}
