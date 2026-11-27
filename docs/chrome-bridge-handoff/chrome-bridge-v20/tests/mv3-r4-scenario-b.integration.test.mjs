import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {createBridge} from '../server/bridge.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms,label)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e.message;}await sleep(150);}throw Error('R4_B_'+label+'_TIMEOUT '+(last||''));};
class Cdp{
 constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});}
 static async connect(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});return new Cdp(ws);}
 call(method,params={}){const id=++this.seq;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;}
 close(){this.ws.close();}
}
async function clickTrusted(cdp,expr){
 const p=await cdp.eval('(()=>{const e='+expr+';if(!e)throw Error("TARGET_MISSING");e.scrollIntoView({block:"center",inline:"center"});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,insideViewport:x>=0&&y>=0&&x<innerWidth&&y<innerHeight,hitMatches:!!hit&&(hit===e||e.contains(hit)),hitTag:hit?.tagName||null,targetTag:e.tagName,rect:{left:r.left,top:r.top,width:r.width,height:r.height}}})()');
 if(!p.insideViewport||!p.hitMatches)throw Error('CDP_CLICK_TARGET_NOT_HIT '+JSON.stringify(p));
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await cdp.call('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});
}
test('R4 Scenario B: trusted global Revoke cancels A, blocks queued B and survives worker reload',{timeout:180000},async()=>{
 const browser=process.env.CHROME_BIN;assert.ok(browser&&fs.existsSync(browser),'CHROME_FOR_TESTING_REQUIRED');
 const xvfb=spawnSync('which',['xvfb-run'],{encoding:'utf8'});assert.equal(xvfb.status,0,'XVFB_REQUIRED');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-r4-b-')),ext=path.join(dir,'extension'),profile=path.join(dir,'profile'),state=path.join(dir,'state');
 fs.mkdirSync(ext);fs.mkdirSync(profile);fs.mkdirSync(path.join(profile,'Default'),{recursive:true});
 fs.writeFileSync(path.join(profile,'Default','Preferences'),JSON.stringify({extensions:{ui:{developer_mode:true}}}));
 for(const n of fs.readdirSync(new URL('../extension/',import.meta.url))){const src=new URL('../extension/'+n,import.meta.url);if(/\.(js|html|css)$/.test(n)&&fs.statSync(src).isFile())fs.writeFileSync(path.join(ext,n),fs.readFileSync(src,'utf8').replaceAll('http://127.0.0.1:17381','http://127.0.0.1:17481'));}
 const extensionId=[...crypto.createHash('sha256').update(path.resolve(ext)).digest('hex').slice(0,32)].map(c=>'abcdefghijklmnop'[parseInt(c,16)]).join('');
 const browserToken=crypto.randomBytes(32).toString('hex'),agentToken=crypto.randomBytes(32).toString('hex');
 fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'R4 Scenario B',version:'0.2.0',background:{service_worker:'background.js',type:'module'},action:{default_title:'R4 B'},permissions:['storage','scripting','tabs','offscreen','alarms'],host_permissions:['http://127.0.0.1:17481/*','https://claude.ai/*']}));
 const key=path.join(dir,'key.pem'),crt=path.join(dir,'cert.pem');
 const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',crt,'-days','1','-subj','/CN=claude.ai','-addext','subjectAltName=DNS:claude.ai'],{encoding:'utf8'});assert.equal(cert.status,0,'TLS_FIXTURE_CERT_FAILED');
 const html='<!doctype html><html><body><div class="font-claude-response">Fixture baseline</div><div contenteditable="true" class="ProseMirror" role="textbox" style="min-height:42px;min-width:240px;border:1px solid #777"></div><button type="button" data-testid="chat-input-send">Send</button><script>document.querySelector("button").addEventListener("click",e=>e.currentTarget.dataset.clicked="true")</script></body></html>';
 const tls=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(crt)},(req,res)=>{if(!/^\/chat\/[A-Za-z0-9_-]{8,128}$/.test(new URL(req.url,'https://claude.ai').pathname)){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'text/html'});res.end(html);});
 let chrome=null,worker=null,control=null,bridge=null,proxy=null,rpcId=0;
 const rpc=async(name,args={})=>{const r=await fetch('http://127.0.0.1:17481/mcp',{method:'POST',headers:{authorization:'Bearer '+agentToken,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})});assert.equal(r.status,200);const d=await r.json();if(d.error)throw Error(d.error.message);const t=d.result?.content?.find(x=>x.type==='text')?.text;return t?JSON.parse(t):d.result;};
 try{
  await new Promise((r,j)=>{tls.once('error',j);tls.listen(8443,'127.0.0.1',r);});
  proxy=http.createServer();
  proxy.on('connect',(req,client,head)=>{
    if(req.url!=='claude.ai:443'){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    const upstream=net.connect(8443,'127.0.0.1');
    upstream.once('connect',()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);
      client.pipe(upstream);upstream.pipe(client);
    });
    upstream.on('error',()=>client.destroy());
    client.on('error',()=>upstream.destroy());
    client.on('close',()=>upstream.destroy());
    upstream.on('close',()=>client.destroy());
  });
  await new Promise((r,j)=>{proxy.once('error',j);proxy.listen(0,'127.0.0.1',r);});
  const proxyPort=proxy.address().port;
  bridge=createBridge({browserToken,agentToken,extensionId},{timeout:120000,pollHold:500,settleMs:100,stateDir:state});
  await new Promise((r,j)=>{bridge.once('error',j);bridge.listen(17481,'127.0.0.1',r);});
  chrome=spawn(xvfb.stdout.trim(),['-a',browser,'--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-background-networking','--ignore-certificate-errors','--proxy-server=http://127.0.0.1:'+proxyPort,'--remote-allow-origins=*','--user-data-dir='+profile,'--load-extension='+ext,'--disable-extensions-except='+ext,'--remote-debugging-port=0','about:blank'],{stdio:'ignore',detached:true});
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
  await until(()=>control.eval('document.querySelector("#status").textContent.includes("Подключено")'),10000,'CONTROL_CONNECTED');
  await until(()=>control.eval('document.querySelector("#mutationLab").checked===true'),8000,'LAB_ON');
  await control.eval('document.querySelector("#backgroundGrantAll").addEventListener("click",e=>window.__r4GrantClickTrusted=e.isTrusted,{capture:true})');
  await clickTrusted(control,'document.querySelector("#backgroundGrantAll")');
  try {
    await until(()=>control.eval('document.querySelectorAll("#backgroundGrantList .approval").length===2'),12000,'GRANTS');
  } catch(error) {
    const ui=await control.eval('JSON.stringify({trusted:window.__r4GrantClickTrusted,status:document.querySelector("#status")?.textContent,grantStatus:document.querySelector("#backgroundGrantStatus")?.textContent,prerequisite:document.querySelector("#backgroundGrantPrerequisite")?.textContent,mode:document.querySelector("#backgroundMode")?.checked,lab:document.querySelector("#mutationLab")?.checked,rows:document.querySelector("#backgroundGrantList")?.textContent})');
    const state=await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"background-control-status"})))()');
    const tabsState=await worker.eval('(async()=>JSON.stringify({tabs:(await chrome.tabs.query({})).filter(t=>(t.url||"").startsWith("https://claude.ai/")).map(t=>({id:t.id,url:t.url})),permission:await chrome.permissions.contains({origins:["https://claude.ai/*"]})}))()');
    console.error('[R4 GRANT DIAGNOSTIC]',ui,state,tabsState);
    throw error;
  }
  const aBind=await rpc('agent_bind',{name:'r4_global_a',tabId:tabs.a}),bBind=await rpc('agent_bind',{name:'r4_global_b',tabId:tabs.b});
  assert.equal(aBind.adapterVerified,true);assert.equal(bBind.adapterVerified,true);
  const make=(s,tabId,conversationId,message)=>({requestId:'r4global'+s,taskId:'r4globaltask'+s,providerId:'claude',tabId,origin:'https://claude.ai',conversationId,epoch:1,message,payloadHash:crypto.createHash('sha256').update(message).digest('hex')});
  const aArgs=make('A000001',tabs.a,'r4scenarioA001','A must be cancelled by global Revoke');
  const bArgs=make('B000001',tabs.b,'r4scenarioB001','B must be blocked after global Revoke');
  const aPromise=rpc('provider_prepare',aArgs);
  await until(()=>control.eval('document.querySelectorAll("#backgroundApprovals .approval").length===1'),15000,'A_APPROVAL');
  assert.ok((await control.eval('document.querySelector("#backgroundApprovals .approval").textContent')).includes(String(tabs.a)));
  const bPromise=rpc('provider_prepare',bArgs);
  await until(async()=>(await rpc('browser_status')).queued>=2,10000,'B_QUEUED');
  await sleep(500);
  assert.equal(await control.eval('document.querySelectorAll("#backgroundApprovals .approval").length'),1,
    'single-writer MCP must leave B queued behind A before global Revoke');

  await control.eval('window.__r4GlobalRevokeTrusted=null;document.querySelector("#backgroundRevokeAll").addEventListener("click",e=>window.__r4GlobalRevokeTrusted=e.isTrusted,{capture:true})');
  await clickTrusted(control,'document.querySelector("#backgroundRevokeAll")');
  await until(()=>control.eval('window.__r4GlobalRevokeTrusted===true'),3000,'GLOBAL_REVOKE_TRUSTED_CLICK');
  try {
    await until(()=>control.eval('document.querySelector("#backgroundGrantStatus").textContent.includes("Управление всеми вкладками отозвано")'),20000,'GLOBAL_REVOKE_ACK');
  } catch(error) {
    const ui=await control.eval('JSON.stringify({trusted:window.__r4GlobalRevokeTrusted,status:document.querySelector("#status")?.textContent,grantStatus:document.querySelector("#backgroundGrantStatus")?.textContent,grants:[...document.querySelectorAll("#backgroundGrantList .approval")].map(e=>e.textContent),approvals:[...document.querySelectorAll("#backgroundApprovals .approval")].map(e=>e.textContent),lab:document.querySelector("#mutationLab")?.checked})');
    const coordinator=await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"background-control-status"})))()');
    const queue=await rpc('browser_status');
    const durable=await worker.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get(["bridgeMutationRevocationPending","bridgeMutationLabMode"]),chrome.storage.session.get(["bridgeMutationRevocationPending","bridgeBackgroundControlGrants"])]);return JSON.stringify({localFence:l.bridgeMutationRevocationPending||null,sessionFence:s.bridgeMutationRevocationPending||null,lab:l.bridgeMutationLabMode===true,grants:s.bridgeBackgroundControlGrants||{}})})()');
    console.error('[R4 GLOBAL REVOKE DIAGNOSTIC]',ui,coordinator,JSON.stringify(queue),durable);
    throw Error(error.message+' UI='+ui+' COORDINATOR='+coordinator+' DURABLE='+durable);
  }

  const [aResult,bResult]=await Promise.all([
    Promise.race([aPromise,sleep(20000).then(()=>{throw Error('A_NOT_CANCELLED_BY_GLOBAL_REVOKE');})]),
    Promise.race([bPromise,sleep(30000).then(()=>{throw Error('B_NOT_BLOCKED_AFTER_GLOBAL_REVOKE');})])
  ]);
  console.log('[R4 GLOBAL REVOKE OUTCOMES]',JSON.stringify({a:{state:aResult.state,reasonCode:aResult.reasonCode},b:{state:bResult.state,reasonCode:bResult.reasonCode}}));
  assert.equal(aResult.state,'BLOCKED','global Revoke must cancel the active A approval');
  assert.equal(bResult.state,'BLOCKED','queued B must be rejected after global Control is disabled');
  const ui=JSON.parse(await control.eval('JSON.stringify({grants:[...document.querySelectorAll("#backgroundGrantList .approval")].map(e=>e.textContent),pending:document.querySelectorAll("#backgroundApprovals .approval").length,status:document.querySelector("#backgroundGrantStatus").textContent,lab:document.querySelector("#mutationLab").checked})'));
  assert.deepEqual(ui.grants,[],'global Revoke must remove every per-tab Grant from the Control UI');
  assert.equal(ui.pending,0,'global Revoke must immediately remove every pending Approval from the UI');
  assert.equal(ui.lab,false,'global Revoke must disable the mutation lab');
  const approvalState=JSON.parse(await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"approval-list"})))()'));
  assert.deepEqual(approvalState.pending,[],'coordinator must have no pending approval after global Revoke');

  const coordinator=JSON.parse(await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"background-control-status"})))()'));
  assert.equal(coordinator.available,true);assert.equal(coordinator.grantsKnown,true);
  assert.equal(coordinator.activeCount,0);assert.deepEqual(coordinator.grants,[]);
  assert.equal(coordinator.mutationEnabled,false);
  assert.equal(coordinator.approvalPending,0);
  const durable=await worker.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get(["bridgeMutationRevocationPending","bridgeMutationRevokingTabs","bridgeMutationQuarantinedTabs","bridgeMutationQuarantineLock","bridgeMutationLabMode"]),chrome.storage.session.get(["bridgeMutationRevocationPending","bridgeMutationRevokingTabs","bridgeMutationQuarantinedTabs","bridgeMutationQuarantineLock","bridgeBackgroundControlGrants"])]);return{localFence:l.bridgeMutationRevocationPending||null,sessionFence:s.bridgeMutationRevocationPending||null,localRevoking:l.bridgeMutationRevokingTabs||[],sessionRevoking:s.bridgeMutationRevokingTabs||[],quarantined:[...new Set([...(l.bridgeMutationQuarantinedTabs||[]),...(s.bridgeMutationQuarantinedTabs||[])])],quarantineLock:l.bridgeMutationQuarantineLock===true||s.bridgeMutationQuarantineLock===true,sessionGrants:s.bridgeBackgroundControlGrants||{},mutationLab:l.bridgeMutationLabMode===true}})()');
  assert.equal(durable.localFence,null,'local global Revoke fence must be reconciled');
  assert.equal(durable.sessionFence,null,'session global Revoke fence must be reconciled');
  assert.deepEqual(durable.localRevoking,[]);assert.deepEqual(durable.sessionRevoking,[]);
  assert.deepEqual(durable.quarantined,[],'a clean global Revoke must not quarantine drained tabs');
  assert.equal(durable.quarantineLock,false);
  assert.deepEqual(durable.sessionGrants,{});
  assert.equal(durable.mutationLab,false);

  const pageState=await worker.eval('(async()=>{const out=await Promise.all(['+tabs.a+','+tabs.b+'].map(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>({draft:(document.querySelector("[contenteditable=true]")?.innerText||"").trim(),clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true"})})));return{a:out[0][0].result,b:out[1][0].result};})()');
  assert.equal(pageState.a.draft,'');assert.equal(pageState.a.clicked,false);
  assert.equal(pageState.b.draft,'');assert.equal(pageState.b.clicked,false);

  // A real extension reload replaces the MV3 worker. No cleared Grant or
  // pending approval may be resurrected from profile or session state.
  control.close();control=null;
  try { await worker.eval('chrome.runtime.reload();true'); } catch {}
  worker.close();worker=null;
  await sleep(500);
  const restarted=await until(async()=>(await targets()).find(x=>x.type==='service_worker'&&x.url==='chrome-extension://'+extensionId+'/background.js'&&x.webSocketDebuggerUrl),20000,'WORKER_AFTER_GLOBAL_REVOKE');
  worker=await Cdp.connect(restarted.webSocketDebuggerUrl);await worker.call('Runtime.enable');
  await until(()=>worker.eval('!!chrome.storage?.local&&!!chrome.runtime?.id'),10000,'RESTARTED_WORKER_API');
  const controlTarget=await until(async()=>(await targets()).find(x=>x.type==='page'&&x.url==='chrome-extension://'+extensionId+'/control.html'&&x.webSocketDebuggerUrl),15000,'CONTROL_AFTER_GLOBAL_REVOKE_RELOAD');
  control=await Cdp.connect(controlTarget.webSocketDebuggerUrl);await control.call('Runtime.enable');
  await until(()=>control.eval('document.readyState!=="loading"&&!!document.querySelector("#backgroundGrantList")'),12000,'CONTROL_AFTER_RELOAD_READY');
  await until(async()=>(await rpc('browser_status')).connected===true,20000,'CONNECTED_AFTER_GLOBAL_REVOKE_RELOAD');
  await until(()=>control.eval('document.querySelector("#status").textContent.includes("Подключено")'),12000,'CONTROL_RECONNECTED');

  const afterCoordinator=JSON.parse(await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"background-control-status"})))()'));
  const afterApprovals=JSON.parse(await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"approval-list"})))()'));
  assert.equal(afterCoordinator.available,true);assert.equal(afterCoordinator.grantsKnown,true);
  assert.equal(afterCoordinator.activeCount,0);assert.deepEqual(afterCoordinator.grants,[]);
  assert.equal(afterCoordinator.mutationEnabled,false);assert.equal(afterCoordinator.approvalPending,0);
  assert.deepEqual(afterApprovals.pending,[]);
  const afterDurable=await worker.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get(["bridgeMutationRevocationPending","bridgeMutationRevokingTabs","bridgeMutationQuarantinedTabs","bridgeMutationQuarantineLock","bridgeMutationLabMode"]),chrome.storage.session.get(["bridgeMutationRevocationPending","bridgeMutationRevokingTabs","bridgeMutationQuarantinedTabs","bridgeMutationQuarantineLock","bridgeBackgroundControlGrants"])]);return{localFence:l.bridgeMutationRevocationPending||null,sessionFence:s.bridgeMutationRevocationPending||null,localRevoking:l.bridgeMutationRevokingTabs||[],sessionRevoking:s.bridgeMutationRevokingTabs||[],quarantined:[...new Set([...(l.bridgeMutationQuarantinedTabs||[]),...(s.bridgeMutationQuarantinedTabs||[])])],quarantineLock:l.bridgeMutationQuarantineLock===true||s.bridgeMutationQuarantineLock===true,sessionGrants:s.bridgeBackgroundControlGrants||{},mutationLab:l.bridgeMutationLabMode===true}})()');
  assert.equal(afterDurable.localFence,null);assert.equal(afterDurable.sessionFence,null);
  assert.deepEqual(afterDurable.localRevoking,[]);assert.deepEqual(afterDurable.sessionRevoking,[]);
  assert.deepEqual(afterDurable.quarantined,[]);assert.equal(afterDurable.quarantineLock,false);
  assert.deepEqual(afterDurable.sessionGrants,{});assert.equal(afterDurable.mutationLab,false);
  const afterPageState=await worker.eval('(async()=>{const out=await Promise.all(['+tabs.a+','+tabs.b+'].map(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>({draft:(document.querySelector("[contenteditable=true]")?.innerText||"").trim(),clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true"})})));return{a:out[0][0].result,b:out[1][0].result};})()');
  assert.equal(afterPageState.a.draft,'');assert.equal(afterPageState.a.clicked,false);
  assert.equal(afterPageState.b.draft,'');assert.equal(afterPageState.b.clicked,false);
  console.log('[R4 SCENARIO B PASS] trusted global Revoke cancels A, blocks queued B, clears Grants/fences/Approvals and survives MV3 reload without Send clicks');
 }finally{
  control?.close();worker?.close();
  if(chrome&&!chrome.killed){try{process.kill(-chrome.pid,'SIGTERM');}catch{chrome.kill('SIGTERM');}}
  if(bridge?.listening)await new Promise(r=>bridge.close(r));
  if(tls.listening)await new Promise(r=>tls.close(r));
  if(proxy?.listening)await new Promise(r=>proxy.close(r));
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch(e){console.warn('[R4 B] fixture cleanup deferred',e.code);}
 }
});
