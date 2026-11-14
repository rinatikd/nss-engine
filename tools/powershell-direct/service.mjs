import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runApproved,validateTask,canonicalWorkspace} from './runner.mjs';

const PORT=17486, secret=()=>crypto.randomBytes(32).toString('hex');
const match=(a,b)=>{const x=Buffer.from(typeof a==='string'?a:''),y=Buffer.from(typeof b==='string'?b:'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clean=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const send=(res,status,obj)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(obj));};

export class PowerShellApprovalService {
 constructor({root,port=PORT,agentToken=secret(),uiToken=secret(),now=Date.now,run=runApproved,workspaceCheck=canonicalWorkspace,chatReadonlyEnabled=false}={}){
  const normalizedRoot=typeof root==='string'?path.win32.normalize(root):'';
  const driveRoot=normalizedRoot&&path.win32.parse(normalizedRoot).root.toLowerCase()===normalizedRoot.toLowerCase();
  const pathSegments=normalizedRoot.toLowerCase().split(path.win32.sep);
  if(!root||!path.win32.isAbsolute(root)||(port!==PORT&&port!==0)||driveRoot||
     normalizedRoot.startsWith('\\\\')||
     pathSegments.some(x=>['windows','system32','program files'].includes(x)))
    throw Error('SAFE_ROOT_AND_PORT_REQUIRED');
  this.root=root;this.port=port;this.agentToken=agentToken;this.uiToken=uiToken;this.now=now;this.run=run;this.workspaceCheck=workspaceCheck;
  this.chatReadonlyEnabled=chatReadonlyEnabled===true;
  this.jobs=new Map();this.active=null;this.server=http.createServer((req,res)=>this.route(req,res));
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
   {name:'powershell_propose',description:'Create a pending fixed read-only Windows task, requiring local browser approval before execution.',inputSchema:{type:'object',properties:{requestId:{type:'string'},task:{type:'string',enum:['git-status','git-diff-check','dotnet-version','node-version','powershell-version']},workspace:{type:'string'}},required:['requestId','task','workspace'],additionalProperties:false}},
   {name:'powershell_cancel',description:'Cancel a pending proposed job without executing anything; cannot cancel an already-running command.',inputSchema:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}},
   {name:'powershell_job',description:'Read the status/result of a proposed PowerShell job; no dispatch.',inputSchema:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}},
   ...(this.chatReadonlyEnabled?[{name:'powershell_chat_readonly',description:'Execute one pinned read-only diagnostic on the Work PC after explicit ChatGPT host approval (plugin permission MUST be Always ask). NO local approval; no arbitrary shell.',inputSchema:{type:'object',properties:{requestId:{type:'string'},task:{type:'string',enum:['git-status','git-diff-check','dotnet-version','node-version','powershell-version']},workspace:{type:'string'}},required:['requestId','task','workspace'],additionalProperties:false}}]:[])
  ]}};
  if(b.method==='tools/call')try{
   const n=b.params?.name,a=b.params?.arguments||{};
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
    const r=this.rpc(JSON.parse(await this.read(req)||'{}'));
    return r===null?send(res,202,{}):send(res,200,r);
   }
   if(url.pathname==='/approve'&&req.method==='GET'){
    if(!match(url.searchParams.get('key'),this.uiToken))return send(res,403,{error:'UI_AUTH_REQUIRED'});
    const rows=[...this.jobs.values()].filter(j=>this.status(j.payload.id).state==='PENDING').map(j=>{
     const p=j.payload;return '<form method="POST" action="/decide?key='+encodeURIComponent(this.uiToken)+'"><p><b>'+clean(p.task)+'</b><br>'+clean(p.workspace)+'<br><code>'+clean(p.exe+' '+p.argv.join(' '))+'</code><br>SHA256 '+clean(j.sha256)+'</p><input type="hidden" name="id" value="'+clean(p.id)+'"><input type="hidden" name="sha256" value="'+clean(j.sha256)+'"><button name="approved" value="yes">Approve once</button> <button name="approved" value="no">Deny</button></form>';
    }).join('');
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'origin','content-security-policy':"default-src 'none'; form-action 'self'; base-uri 'none'"});
    return res.end('<!doctype html><html><meta charset="utf-8"><h2>Local PowerShell approval</h2><p>Only approve commands already confirmed in ChatGPT.</p>'+(rows||'<p>No pending commands.</p>')+'</html>');
   }
   if(url.pathname==='/decide'&&req.method==='POST'){
    if(!match(url.searchParams.get('key'),this.uiToken))return send(res,403,{error:'UI_AUTH_REQUIRED'});
    if(req.headers.origin!=='http://127.0.0.1:'+this.port)return send(res,403,{error:'ORIGIN_DENIED'});
    const f=new URLSearchParams(await this.read(req,2048));
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
