import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import https from 'node:https';
import {createBridge} from '../server/bridge.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms,label)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e.message;}await sleep(150);}throw Error('R4_A_'+label+'_TIMEOUT '+(last||''));};
class Cdp{
 constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});}
 static async connect(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});return new Cdp(ws);}
 call(method,params={}){const id=++this.seq;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;}
 close(){this.ws.close();}
}
async function clickTrusted(cdp,expr){
 const p=await cdp.eval('(()=>{const e='+expr+';if(!e)throw Error("TARGET_MISSING");const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()');
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await cdp.call('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});
}
test('R4 Scenario A: real MV3 Control Revoke cancels A and preserves queued B over HTTP MCP',{timeout:180000},async()=>{
 const browser=process.env.CHROME_BIN;assert.ok(browser&&fs.existsSync(browser),'CHROME_FOR_TESTING_REQUIRED');
 const xvfb=spawnSync('which',['xvfb-run'],{encoding:'utf8'});assert.equal(xvfb.status,0,'XVFB_REQUIRED');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-r4-a-')),ext=path.join(dir,'extension'),profile=path.join(dir,'profile'),state=path.join(dir,'state');
 fs.mkdirSync(ext);fs.mkdirSync(profile);fs.mkdirSync(path.join(profile,'Default'),{recursive:true});
 fs.writeFileSync(path.join(profile,'Default','Preferences'),JSON.stringify({extensions:{ui:{developer_mode:true}}}));
 for(const n of fs.readdirSync(new URL('../extension/',import.meta.url))){const src=new URL('../extension/'+n,import.meta.url);if(/\.(js|html|css)$/.test(n)&&fs.statSync(src).isFile())fs.writeFileSync(path.join(ext,n),fs.readFileSync(src,'utf8').replaceAll('http://127.0.0.1:17381','http://127.0.0.1:17481'));}
 const extensionId=[...crypto.createHash('sha256').update(path.resolve(ext)).digest('hex').slice(0,32)].map(c=>'abcdefghijklmnop'[parseInt(c,16)]).join('');
 const browserToken=crypto.randomBytes(32).toString('hex'),agentToken=crypto.randomBytes(32).toString('hex');
 fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'R4 Scenario A',version:'0.2.0',background:{service_worker:'background.js',type:'module'},action:{default_title:'R4 A'},permissions:['storage','scripting','tabs','offscreen','alarms'],host_permissions:['http://127.0.0.1:17481/*','https://claude.ai/*']}));
 const key=path.join(dir,'key.pem'),crt=path.join(dir,'cert.pem');
 const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',crt,'-days','1','-subj','/CN=claude.ai','-addext','subjectAltName=DNS:claude.ai'],{encoding:'utf8'});assert.equal(cert.status,0,'TLS_FIXTURE_CERT_FAILED');
 const html='<!doctype html><html><body><div class="font-claude-response">Fixture baseline</div><div contenteditable="true" class="ProseMirror" role="textbox" style="min-height:42px;min-width:240px;border:1px solid #777"></div><button type="button" data-testid="chat-input-send">Send</button><script>document.querySelector("button").addEventListener("click",e=>e.currentTarget.dataset.clicked="true")</script></body></html>';
 const tls=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(crt)},(req,res)=>{if(!/^\/chat\/[A-Za-z0-9_-]{8,128}$/.test(new URL(req.url,'https://claude.ai').pathname)){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'text/html'});res.end(html);});
 let chrome=null,worker=null,control=null,bridge=null,rpcId=0;
 const rpc=async(name,args={})=>{const r=await fetch('http://127.0.0.1:17481/mcp',{method:'POST',headers:{authorization:'Bearer '+agentToken,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})});assert.equal(r.status,200);const d=await r.json();if(d.error)throw Error(d.error.message);const t=d.result?.content?.find(x=>x.type==='text')?.text;return t?JSON.parse(t):d.result;};
 try{
  await new Promise((r,j)=>{tls.once('error',j);tls.listen(443,'127.0.0.1',r);});
  bridge=createBridge({browserToken,agentToken,extensionId},{timeout:120000,pollHold:500,settleMs:100,stateDir:state});
  await new Promise((r,j)=>{bridge.once('error',j);bridge.listen(17481,'127.0.0.1',r);});
  chrome=spawn(xvfb.stdout.trim(),['-a',browser,'--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-background-networking','--ignore-certificate-errors','--host-resolver-rules=MAP claude.ai 127.0.0.1','--remote-allow-origins=*','--user-data-dir='+profile,'--load-extension='+ext,'--disable-extensions-except='+ext,'--remote-debugging-port=0','about:blank'],{stdio:'ignore',detached:true});
  const port=await until(()=>{const p=path.join(profile,'DevToolsActivePort');return fs.existsSync(p)?Number(fs.readFileSync(p,'utf8').split(/\r?\n/)[0]):0;},15000,'DEBUG_PORT');
  const targets=async()=>(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json());
  const w=await until(async()=>(await targets()).find(x=>x.type==='service_worker'&&x.url==='chrome-extension://'+extensionId+'/background.js'&&x.webSocketDebuggerUrl),15000,'WORKER');
  worker=await Cdp.connect(w.webSocketDebuggerUrl);await worker.call('Runtime.enable');
  await until(()=>worker.eval('!!chrome.storage?.local&&!!chrome.runtime?.id'),10000,'WORKER_API');
  const seed='(async()=>{await chrome.storage.local.set({browserToken:'+JSON.stringify(browserToken)+',bridgeBackgroundMode:true,bridgeConnectionDesired:true,bridgeMutationLabMode:true,sites:{"https://claude.ai":{mode:"chat",adapter:"claude"}},adapters:"{}"});const a=await chrome.tabs.create({url:"https://claude.ai/chat/r4scenarioA001",active:false});const b=await chrome.tabs.create({url:"https://claude.ai/chat/r4scenarioB001",active:false});const c=await chrome.tabs.create({url:chrome.runtime.getURL("control.html"),active:true});return{a:a.id,b:b.id,c:c.id};})()';
  const tabs=await worker.eval(seed);
  const ct=await until(async()=>(await targets()).find(x=>x.type==='page'&&x.url==='chrome-extension://'+extensionId+'/control.html'&&x.webSocketDebuggerUrl),15000,'CONTROL');
  control=await Cdp.connect(ct.webSocketDebuggerUrl);await control.call('Runtime.enable');
  await until(()=>control.eval('document.readyState==="complete"&&!!document.querySelector("#backgroundGrantAll")'),12000,'CONTROL_READY');
  await control.eval('window.confirm=()=>true');
  await until(async()=>(await rpc('browser_status')).connected===true,20000,'CONNECTED');
  await until(()=>control.eval('document.querySelector("#mutationLab").checked===true'),8000,'LAB_ON');
  await clickTrusted(control,'document.querySelector("#backgroundGrantAll")');
  await until(()=>control.eval('document.querySelectorAll("#backgroundGrantList .approval").length===2'),12000,'GRANTS');
  const aBind=await rpc('agent_bind',{name:'r4_a',tabId:tabs.a}),bBind=await rpc('agent_bind',{name:'r4_b',tabId:tabs.b});
  assert.equal(aBind.adapterVerified,true);assert.equal(bBind.adapterVerified,true);
  const make=(s,tabId,conversationId,message)=>({requestId:'r4request'+s,taskId:'r4task'+s,providerId:'claude',tabId,origin:'https://claude.ai',conversationId,epoch:1,message,payloadHash:crypto.createHash('sha256').update(message).digest('hex')});
  const aArgs=make('A0000001',tabs.a,'r4scenarioA001','A must not be prepared');
  const bArgs=make('B0000001',tabs.b,'r4scenarioB001','B may be prepared but never sent');
  const aPromise=rpc('provider_prepare',aArgs);
  await until(()=>control.eval('document.querySelectorAll("#backgroundApprovals .approval").length===1'),15000,'A_APPROVAL');
  assert.ok((await control.eval('document.querySelector("#backgroundApprovals .approval").textContent')).includes(String(tabs.a)));
  let aSettled=false;const aTracked=aPromise.then(v=>(aSettled=true,v));
  const bPromise=rpc('provider_prepare',bArgs);
  await until(async()=>(await rpc('browser_status')).queued>=2,10000,'B_QUEUED');
  await sleep(500);assert.equal(await control.eval('document.querySelectorAll("#backgroundApprovals .approval").length'),1,'B must not create a parallel approval');
  const revokeExpr='[...document.querySelectorAll("#backgroundGrantList .approval")].find(e=>e.textContent.includes('+JSON.stringify(String(tabs.a))+'))?.querySelector("button")';
  await clickTrusted(control,revokeExpr);
  const grantText=await until(async()=>{const s=await control.eval('JSON.stringify([...document.querySelectorAll("#backgroundGrantList .approval")].map(e=>e.textContent))');return s.includes(String(tabs.a))?null:s;},12000,'A_REVOKED');
  assert.ok(!grantText.includes(String(tabs.a))&&grantText.includes(String(tabs.b)));
  const aResult=await Promise.race([aTracked,sleep(12000).then(()=>{throw Error('A_NOT_CANCELLED');})]);
  assert.equal(aResult.state,'BLOCKED');assert.equal(aSettled,true);
  await until(()=>control.eval('document.querySelectorAll("#backgroundApprovals .approval").length===1'),15000,'B_APPROVAL');
  assert.ok((await control.eval('document.querySelector("#backgroundApprovals .approval").textContent')).includes(String(tabs.b)));
  const approveExpr='[...document.querySelectorAll("#backgroundApprovals .approval")].find(e=>e.textContent.includes('+JSON.stringify(String(tabs.b))+'))?.querySelector("button:not(.danger)")';
  await clickTrusted(control,approveExpr);
  const bResult=await Promise.race([bPromise,sleep(30000).then(()=>{throw Error('B_NOT_COMPLETED');})]);
  assert.equal(bResult.state,'PREPARED');assert.equal(bResult.identity.tabId,tabs.b);
  const ui=JSON.parse(await control.eval('JSON.stringify({grants:[...document.querySelectorAll("#backgroundGrantList .approval")].map(e=>e.textContent),pending:document.querySelectorAll("#backgroundApprovals .approval").length})'));
  assert.equal(ui.grants.length,1);assert.ok(ui.grants[0].includes(String(tabs.b)));assert.equal(ui.pending,0);
  const pageState=await worker.eval('(async()=>{const out=await Promise.all(['+tabs.a+','+tabs.b+'].map(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>({draft:(document.querySelector("[contenteditable=true]")?.innerText||"").trim(),clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true"})})));return{a:out[0][0].result,b:out[1][0].result};})()');
  assert.equal(pageState.a.draft,'');assert.equal(pageState.a.clicked,false);assert.equal(pageState.b.draft,bArgs.message);assert.equal(pageState.b.clicked,false);
  console.log('[R4 SCENARIO A PASS] A cancelled/B queued then PREPARED; trusted per-tab Revoke; B Grant retained; no Send clicks');
 }finally{
  control?.close();worker?.close();
  if(chrome&&!chrome.killed){try{process.kill(-chrome.pid,'SIGTERM');}catch{chrome.kill('SIGTERM');}}
  if(bridge?.listening)await new Promise(r=>bridge.close(r));
  if(tls.listening)await new Promise(r=>tls.close(r));
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch(e){console.warn('[R4 A] fixture cleanup deferred',e.code);}
 }
});
