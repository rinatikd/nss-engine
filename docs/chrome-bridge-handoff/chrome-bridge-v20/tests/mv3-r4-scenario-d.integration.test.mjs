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
const bounded= (promise,ms,label)=>new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error(label+'_TIMEOUT')),ms);
 Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});
const boundedFetch=async(url,options={},timeoutMs=10000)=>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{return await fetch(url,{...options,signal:controller.signal});}
 finally{clearTimeout(timer);}
};
const until=async(fn,ms,label)=>{
 const end=Date.now()+ms;let last;
 while(Date.now()<end){
  try{const v=await bounded(Promise.resolve().then(fn),Math.min(12000,end-Date.now()),'R4_D_'+label+'_PROBE');if(v)return v;}
  catch(e){last=e.message;}
  await sleep(150);
 }
 throw Error('R4_D_'+label+'_TIMEOUT '+(last||''));
};
class Cdp{
 constructor(ws,label='target'){
  this.ws=ws;this.label=label;this.seq=0;this.pending=new Map();
  ws.addEventListener('message',e=>{
   let m;try{m=JSON.parse(e.data);}catch{return;}
   const pending=this.pending.get(m.id);if(!pending)return;
   this.pending.delete(m.id);
   m.error?pending.reject(Error(JSON.stringify(m.error))):pending.resolve(m.result);
  });
  const failPending=()=>{for(const [id,pending] of this.pending){this.pending.delete(id);pending.reject(Error('CDP_SOCKET_CLOSED'));}};
  ws.addEventListener('close',failPending);ws.addEventListener('error',failPending);
 }
 static async connect(url,label='target'){
  const ws=new WebSocket(url);
  await bounded(new Promise((resolve,reject)=>{
   ws.addEventListener('open',resolve,{once:true});
   ws.addEventListener('error',()=>reject(Error('CDP_CONNECT_FAILED')),{once:true});
  }),10000,'CDP_CONNECT '+label);
  return new Cdp(ws,label);
 }
 call(method,params={}){
  const id=++this.seq;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP_CALL_TIMEOUT '+this.label+' '+method));},12000);
   this.pending.set(id,{
    resolve:value=>{clearTimeout(timer);resolve(value);},
    reject:error=>{clearTimeout(timer);reject(error);}
   });
   try{this.ws.send(JSON.stringify({id,method,params}));}
   catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}
  });
 }
 async eval(expression){const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;}
 close(){for(const [id,pending] of this.pending){this.pending.delete(id);pending.reject(Error('CDP_CLIENT_CLOSED'));}try{this.ws.close();}catch{}}
}
async function clickTrusted(cdp,expr){
 const p=await cdp.eval('(()=>{const e='+expr+';if(!e)throw Error("TARGET_MISSING");e.scrollIntoView({block:"center",inline:"center"});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,insideViewport:x>=0&&y>=0&&x<innerWidth&&y<innerHeight,hitMatches:!!hit&&(hit===e||e.contains(hit)),hitTag:hit?.tagName||null,targetTag:e.tagName,rect:{left:r.left,top:r.top,width:r.width,height:r.height}}})()');
 if(!p.insideViewport||!p.hitMatches)throw Error('CDP_CLICK_TARGET_NOT_HIT '+JSON.stringify(p));
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await cdp.call('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});
}
test('R4 Scenario D: interrupted provider_commit remains UNKNOWN and quarantined after MV3/Bridge restart',{timeout:360000},async()=>{
 const browser=process.env.CHROME_BIN;assert.ok(browser&&fs.existsSync(browser),'CHROME_FOR_TESTING_REQUIRED');
 const xvfb=spawnSync('which',['xvfb-run'],{encoding:'utf8'});assert.equal(xvfb.status,0,'XVFB_REQUIRED');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-r4-d-')),ext=path.join(dir,'extension'),profile=path.join(dir,'profile'),state=path.join(dir,'state');
 fs.mkdirSync(ext);fs.mkdirSync(profile);fs.mkdirSync(path.join(profile,'Default'),{recursive:true});
 fs.writeFileSync(path.join(profile,'Default','Preferences'),JSON.stringify({extensions:{ui:{developer_mode:true}}}));
 for(const n of fs.readdirSync(new URL('../extension/',import.meta.url))){const src=new URL('../extension/'+n,import.meta.url);if(/\.(js|html|css)$/.test(n)&&fs.statSync(src).isFile())fs.writeFileSync(path.join(ext,n),fs.readFileSync(src,'utf8').replaceAll('http://127.0.0.1:17381','http://127.0.0.1:17481'));}
  // Test-only receiver in the disposable MV3 worker. Production sources
  // and the production coordinator trust policy remain untouched.
  const backgroundPath=path.join(ext,'background.js');
  let backgroundSource=fs.readFileSync(backgroundPath,'utf8');
  backgroundSource+=`
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.target!=='r4-test-terminal-probe') return false;
  const evidence=message.evidence;
  let senderOrigin=null;
  try { senderOrigin=new URL(sender.url).origin; } catch {}
  const valid=sender?.id===chrome.runtime.id &&
    Number.isSafeInteger(sender?.tab?.id) && sender.tab.id>0 &&
    sender.frameId===0 && typeof sender.documentId==='string' &&
    sender.documentId.length>0 && typeof sender.url==='string' &&
    evidence?.schemaVersion===1 &&
    typeof evidence.requestId==='string' &&
    evidence.origin===senderOrigin &&
    typeof evidence.conversationId==='string' &&
    Number.isFinite(evidence.startedAt) &&
    Number.isFinite(evidence.completedAt) &&
    evidence.completedAt>=evidence.startedAt;
  if(!valid){sendResponse({ok:false,error:'SENDER_OR_EVIDENCE_INVALID'});return false;}
  const envelope={schemaVersion:1,tabId:sender.tab.id,documentId:sender.documentId,
    frameId:sender.frameId,url:sender.url,evidence};
  void chrome.storage.local.set({r4TestTerminalEvidence:envelope})
    .then(()=>sendResponse({ok:true,tabId:sender.tab.id,documentId:sender.documentId}))
    .catch(()=>sendResponse({ok:false,error:'TEST_EVIDENCE_WRITE_FAILED'}));
  return true;
});
`;
  fs.writeFileSync(backgroundPath,backgroundSource);
 // Test-only receipt hold in the disposable extension copy. The real
 // provider_commit click happens first; only its post-click receipt is held,
 // reproducing an uncertain in-flight side effect during worker/Bridge restart.
 const pageActionPath=path.join(ext,'page.js');
 let pageActionSource=fs.readFileSync(pageActionPath,'utf8');
 const commitClickMarker='      sendButtons[0].click();\n      providerCommitClickReturned = true;\n      const clickedAt = new Date().toISOString();';
 const commitClickHook=`      sendButtons[0].click();
      document.documentElement.dataset.r4CommitClickCount =
        String(Number(document.documentElement.dataset.r4CommitClickCount || '0') + 1);
      // The real click has returned; hold only the receipt to model an
      // interrupted provider_commit acknowledgement across worker restart.
      providerCommitClickReturned = true;
      if (document.documentElement.dataset.r4HoldCommitReceipt === 'true') {
        document.documentElement.dataset.r4CommitReceiptHeld = 'true';
        await new Promise(resolve => {
          const timer = setInterval(() => {
            if (document.documentElement.dataset.r4ReleaseCommitReceipt === 'true') {
              clearInterval(timer);
              document.documentElement.dataset.r4CommitReceiptHeld = 'false';
              resolve();
            }
          }, 10);
        });
      }
      const clickedAt = new Date().toISOString();`;
 const finallyMarker='  } finally {\n    releaseActionLock();';
  const finallyHook='  } finally {\n    releaseActionLock();\n    document.documentElement.dataset.r4TestFinallyReached = "true";\n    try {\n      const evidence = globalThis.__chromeBridgeMutationTerminal || null;\n      const response = await chrome.runtime.sendMessage({target:"r4-test-terminal-probe",evidence});\n      document.documentElement.dataset.r4TestRuntimeMessage = response?.ok ? "ok" : "failed:" + String(response?.error || "NO_ACK");\n    } catch (error) {\n      document.documentElement.dataset.r4TestRuntimeMessage = "failed:" + String(error?.message || error).slice(0,120);\n    }';
 assert.ok(pageActionSource.includes(finallyMarker),'PROVIDER_COMMIT_FINALLY_HOOK_MARKER_MISSING');
 pageActionSource=pageActionSource.replace(finallyMarker,finallyHook);
 assert.ok(pageActionSource.includes(commitClickMarker),'PROVIDER_COMMIT_HOOK_MARKER_MISSING');
 pageActionSource=pageActionSource.replace(commitClickMarker,commitClickHook);
 fs.writeFileSync(pageActionPath,pageActionSource);
 const extensionId=[...crypto.createHash('sha256').update(path.resolve(ext)).digest('hex').slice(0,32)].map(c=>'abcdefghijklmnop'[parseInt(c,16)]).join('');
 const browserToken=crypto.randomBytes(32).toString('hex'),agentToken=crypto.randomBytes(32).toString('hex');
 fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'R4 Scenario D',version:'0.2.0',background:{service_worker:'background.js',type:'module'},action:{default_title:'R4 D'},permissions:['storage','scripting','tabs','offscreen','alarms'],host_permissions:['http://127.0.0.1:17481/*','https://claude.ai/*']}));
 const key=path.join(dir,'key.pem'),crt=path.join(dir,'cert.pem');
 const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',crt,'-days','1','-subj','/CN=claude.ai','-addext','subjectAltName=DNS:claude.ai'],{encoding:'utf8'});assert.equal(cert.status,0,'TLS_FIXTURE_CERT_FAILED');
 const html='<!doctype html><html><body><div class="font-claude-response">Fixture baseline</div><div contenteditable="true" class="ProseMirror" role="textbox" style="min-height:42px;min-width:240px;border:1px solid #777"></div><button type="button" data-testid="chat-input-send">Send</button><script>document.querySelector("button").addEventListener("click",e=>{e.currentTarget.dataset.clicked="true";e.currentTarget.dataset.clickCount=String(Number(e.currentTarget.dataset.clickCount||"0")+1)})</script></body></html>';
 const sockets=new Set();
 const trackSocket=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));return socket;};
 const tls=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(crt)},(req,res)=>{if(!/^\/chat\/[A-Za-z0-9_-]{8,128}$/.test(new URL(req.url,'https://claude.ai').pathname)){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'text/html'});res.end(html);});
 tls.on('connection',socket=>trackSocket(socket));
 let chrome=null,worker=null,control=null,pageA=null,pageB=null,bridge=null,proxy=null,rpcId=0;
 const watchdog=setTimeout(()=>{
  console.error('[R4 D WATCHDOG] force-closing disposable Chrome and fixture sockets');
  for(const socket of sockets)socket.destroy();
  try{bridge?.closeAllConnections?.();}catch{}
  try{tls.closeAllConnections?.();}catch{}
  try{proxy?.closeAllConnections?.();}catch{}
  if(chrome&&chrome.exitCode===null){try{process.kill(-chrome.pid,'SIGKILL');}catch{try{chrome.kill('SIGKILL');}catch{}}}
 },360000);
 const rpc=async(name,args={})=>{const r=await boundedFetch('http://127.0.0.1:17481/mcp',{method:'POST',headers:{authorization:'Bearer '+agentToken,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})},12000);assert.equal(r.status,200);const d=await r.json();if(d.error)throw Error(d.error.message);const t=d.result?.content?.find(x=>x.type==='text')?.text;return t?JSON.parse(t):d.result;};
 try{
  await new Promise((r,j)=>{tls.once('error',j);tls.listen(8443,'127.0.0.1',r);});
  proxy=http.createServer();
  proxy.on('connection',socket=>trackSocket(socket));
  proxy.on('connect',(req,client,head)=>{
    if(req.url!=='claude.ai:443'){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    trackSocket(client);
    const upstream=trackSocket(net.connect(8443,'127.0.0.1'));
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
  const targets=async()=>(await(await boundedFetch('http://127.0.0.1:'+port+'/json/list',{},6000)).json());
  const w=await until(async()=>(await targets()).find(x=>x.type==='service_worker'&&x.url==='chrome-extension://'+extensionId+'/background.js'&&x.webSocketDebuggerUrl),15000,'WORKER');
  const originalWorkerTargetId=w.id;
  worker=await Cdp.connect(w.webSocketDebuggerUrl,'worker-initial');await worker.call('Runtime.enable');
  await until(()=>worker.eval('!!chrome.storage?.local&&!!chrome.runtime?.id'),10000,'WORKER_API');
  const seed='(async()=>{await chrome.storage.local.set({browserToken:'+JSON.stringify(browserToken)+',bridgeBackgroundMode:true,bridgeConnectionDesired:true,bridgeMutationLabMode:true,sites:{"https://claude.ai":{mode:"chat",adapter:"claude"}},adapters:"{}"});const a=await chrome.tabs.create({url:"https://claude.ai/chat/r4scenarioDA001",active:false});const b=await chrome.tabs.create({url:"https://claude.ai/chat/r4scenarioDB001",active:false});const c=await chrome.tabs.create({url:chrome.runtime.getURL("control.html"),active:true});return{a:a.id,b:b.id,c:c.id};})()';
  const tabs=await worker.eval(seed);
  // Tabs are created inactive. Do not attach a page CDP session while its
  // renderer is still navigating: Chrome may accept the WebSocket upgrade but
  // defer Runtime.enable until the background renderer is initialized.
  const providerTabs=await until(()=>worker.eval('(async()=>{const [a,b]=await Promise.all([chrome.tabs.get('+tabs.a+'),chrome.tabs.get('+tabs.b+')]);return a.status==="complete"&&b.status==="complete"&&a.url==="https://claude.ai/chat/r4scenarioDA001"&&b.url==="https://claude.ai/chat/r4scenarioDB001"?{a:{status:a.status,url:a.url},b:{status:b.status,url:b.url}}:false})()'),30000,'PROVIDER_TABS_COMPLETE');
  console.log('[R4 D PROVIDER TABS COMPLETE]',JSON.stringify(providerTabs));
  const tabA=await until(async()=>(await targets()).find(x=>x.type==='page'&&x.url==='https://claude.ai/chat/r4scenarioDA001'&&x.webSocketDebuggerUrl),15000,'TAB_A');
  pageA=await Cdp.connect(tabA.webSocketDebuggerUrl,'provider-tab-a-initial');await pageA.call('Runtime.enable');
  const tabB=await until(async()=>(await targets()).find(x=>x.type==='page'&&x.url==='https://claude.ai/chat/r4scenarioDB001'&&x.webSocketDebuggerUrl),15000,'TAB_B');
  pageB=await Cdp.connect(tabB.webSocketDebuggerUrl,'provider-tab-b-initial');await pageB.call('Runtime.enable');
  const ct=await until(async()=>(await targets()).find(x=>x.type==='page'&&x.url==='chrome-extension://'+extensionId+'/control.html'&&x.webSocketDebuggerUrl),15000,'CONTROL');
  control=await Cdp.connect(ct.webSocketDebuggerUrl,'control-initial');await control.call('Runtime.enable');
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
  const aBind=await rpc('agent_bind',{name:'r4_d_inflight',tabId:tabs.a});
  const bBind=await rpc('agent_bind',{name:'r4_d_stale',tabId:tabs.b});
  assert.equal(aBind.adapterVerified,true);assert.equal(bBind.adapterVerified,true);
  const make=(requestId,taskId,tabId,conversationId,message)=>({
    requestId,taskId,providerId:'claude',tabId,origin:'https://claude.ai',
    conversationId,epoch:1,message,payloadHash:crypto.createHash('sha256').update(message).digest('hex')
  });
  const identity=make('r4Drequest0001','r4Dtask0001',tabs.a,'r4scenarioDA001',
    'Scenario D commit will be clicked once, then its receipt is deliberately lost');
  const preparePromise=rpc('provider_prepare',identity);
  await until(()=>control.eval('document.querySelectorAll("#backgroundApprovals .approval").length===1'),15000,'PREPARE_APPROVAL');
  assert.ok((await control.eval('document.querySelector("#backgroundApprovals .approval").textContent')).includes(String(tabs.a)));
  const approvePrepare='[...document.querySelectorAll("#backgroundApprovals .approval")].find(e=>e.textContent.includes('+JSON.stringify(String(tabs.a))+'))?.querySelector("button:not(.danger)")';
  await clickTrusted(control,approvePrepare);
  const preparedResult=await Promise.race([
    preparePromise,
    sleep(30000).then(()=>{throw Error('D_PREPARE_NOT_COMPLETED');})
  ]);
  assert.equal(preparedResult.state,'PREPARED','provider_prepare must complete only after the real Control approval');
  assert.equal(preparedResult.state,'PREPARED');
  assert.equal(preparedResult.sideEffect,'composer-filled-no-send');
  assert.equal(preparedResult.clickedSend,false);
  assert.ok(preparedResult.preparedId&&preparedResult.fencingToken);

  // Arm the hold inside the real Claude page fixture before provider_commit.
  await pageA.eval('(()=>{document.documentElement.dataset.r4HoldCommitReceipt="true";document.documentElement.dataset.r4CommitReceiptHeld="false";document.documentElement.dataset.r4CommitClickCount="0";return true})()');
  const commitArgs={requestId:identity.requestId,taskId:identity.taskId,providerId:identity.providerId,
    tabId:identity.tabId,origin:identity.origin,conversationId:identity.conversationId,epoch:identity.epoch,
    preparedId:preparedResult.preparedId,fencingToken:preparedResult.fencingToken,payloadHash:identity.payloadHash};
  const commitPromise=rpc('provider_commit',commitArgs);
  await until(()=>control.eval('document.querySelectorAll("#backgroundApprovals .approval").length===1'),15000,'COMMIT_APPROVAL');
  assert.ok((await control.eval('document.querySelector("#backgroundApprovals .approval").textContent')).includes(String(tabs.a)));
  const approveCommit='[...document.querySelectorAll("#backgroundApprovals .approval")].find(e=>e.textContent.includes('+JSON.stringify(String(tabs.a))+'))?.querySelector("button:not(.danger)")';
  await clickTrusted(control,approveCommit);
  await until(async()=>{const s=await pageA.eval('(()=>({clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true",count:document.documentElement.dataset.r4CommitClickCount,held:document.documentElement.dataset.r4CommitReceiptHeld==="true"}))()');return s.clicked&&s.held&&s.count==="1";},20000,'SEND_CLICK_RECEIPT_HELD');

  const sendState=await pageA.eval('(()=>({clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true",buttonCount:document.querySelector("[data-testid=chat-input-send]")?.dataset.clickCount||"0",hold:document.documentElement.dataset.r4CommitReceiptHeld==="true"}))()');
  assert.equal(sendState.clicked,true);assert.equal(sendState.buttonCount,'1');assert.equal(sendState.hold,true);

  // Global Revoke must time out draining the deliberately held accepted
  // mutation, clear all grants, and durably quarantine the affected tab.
  await control.eval('window.__r4GlobalRevokeTrusted=null;document.querySelector("#backgroundRevokeAll").addEventListener("click",e=>window.__r4GlobalRevokeTrusted=e.isTrusted,{capture:true})');
  await clickTrusted(control,'document.querySelector("#backgroundRevokeAll")');
  await until(()=>control.eval('window.__r4GlobalRevokeTrusted===true'),3000,'GLOBAL_REVOKE_TRUSTED');
  await until(()=>control.eval('document.querySelector("#backgroundGrantStatus").textContent.includes("Ошибка отключения: UNKNOWN: BACKGROUND_STOP_UNCONFIRMED")'),20000,'GLOBAL_REVOKE_UNKNOWN');
  const unknownUi=JSON.parse(await control.eval('JSON.stringify({grants:[...document.querySelectorAll("#backgroundGrantList .approval")].map(e=>e.textContent),approvals:[...document.querySelectorAll("#backgroundApprovals .approval")].map(e=>e.textContent),error:document.querySelector("#backgroundGrantStatus").textContent,lab:document.querySelector("#mutationLab").checked})'));
  assert.deepEqual(unknownUi.grants,[],'UNKNOWN global Revoke must refresh stale per-tab Grant rows');
  assert.deepEqual(unknownUi.approvals,[],'UNKNOWN global Revoke must remove cancelled Approval rows from the Control UI');
  assert.equal(unknownUi.lab,false,'UNKNOWN global Revoke must leave mutation mode disabled');
  assert.ok(unknownUi.error.includes('UNKNOWN: BACKGROUND_STOP_UNCONFIRMED'));
  const fenceState=await worker.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get(["bridgeMutationRevocationPending","bridgeMutationQuarantinedTabs","bridgeMutationQuarantineLock","bridgeMutationLabMode"]),chrome.storage.session.get(["bridgeMutationRevocationPending","bridgeMutationQuarantinedTabs","bridgeMutationQuarantineLock","bridgeBackgroundControlGrants"])]);return{localFence:l.bridgeMutationRevocationPending||null,sessionFence:s.bridgeMutationRevocationPending||null,localQuarantined:l.bridgeMutationQuarantinedTabs||[],sessionQuarantined:s.bridgeMutationQuarantinedTabs||[],localLock:l.bridgeMutationQuarantineLock===true,sessionLock:s.bridgeMutationQuarantineLock===true,localLab:l.bridgeMutationLabMode===true,sessionGrants:s.bridgeBackgroundControlGrants||{}}})()');
  assert.equal(fenceState.localFence?.pending===true||fenceState.sessionFence?.pending===true,true,
    'Global Revoke must leave a durable pending fence when an accepted mutation cannot be proven drained');
  assert.ok(fenceState.localQuarantined.includes(tabs.a)||fenceState.sessionQuarantined.includes(tabs.a),
    'the in-flight tab must be durably quarantined');
  assert.equal(fenceState.localLab,false,'global Revoke disables the mutation lab');
  assert.deepEqual(fenceState.sessionGrants,{},'global Revoke clears all per-tab grants even when drain is UNKNOWN');
  assert.equal(fenceState.localLock||fenceState.sessionLock,false,
    'a persisted per-tab quarantine and global pending fence are sufficient; no storage-failure lock is expected');

  const grantStatus=JSON.parse(await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"background-control-status"})))()'));
  assert.equal(grantStatus.activeCount,0);assert.deepEqual(grantStatus.grants,[]);
  assert.equal(grantStatus.mutationEnabled,false);assert.equal(grantStatus.approvalPending,0);

  // Restart MV3 while the page action receipt is still held. Do not release
  // the hold: after the Send click, execution state is ambiguous by design.
  control.close();control=null;
  pageA.close();pageA=null;pageB.close();pageB=null;
  // runtime.reload may close its own CDP target before Runtime.evaluate
  // can return when a page-action promise is deliberately still unresolved.
  // Bound the command wait; then observe the replacement worker independently.
  await Promise.race([
    worker.eval('chrome.runtime.reload();true').catch(()=>null),
    sleep(3000)
  ]);
  worker.close();worker=null;
  // Match the known-good MV3 reload ordering from Scenario B: wait until
  // Chromium exposes a replacement service-worker target first, reconnect to
  // that worker, then let the new worker create its own Control page. Opening
  // chrome-extension:// pages before extension reload has completed can make
  // Chromium reject the navigation as ERR_BLOCKED_BY_CLIENT.
  await sleep(500);
  const restartedWorker=await until(async()=>(await targets()).find(x=>
    x.type==='service_worker'&&x.url==='chrome-extension://'+extensionId+'/background.js'&&
    x.webSocketDebuggerUrl&&x.id!==originalWorkerTargetId),20000,'WORKER_AFTER_INFLIGHT_RELOAD');
  assert.notEqual(restartedWorker.id,originalWorkerTargetId,'MV3_RELOAD_MUST_CREATE_A_NEW_WORKER_TARGET');
  worker=await Cdp.connect(restartedWorker.webSocketDebuggerUrl,'worker-after-reload');
  await worker.call('Runtime.enable');
  await until(()=>worker.eval('!!chrome.storage?.local&&!!chrome.runtime?.id'),10000,'RESTARTED_WORKER_API');
  await worker.eval('(async()=>chrome.tabs.create({url:chrome.runtime.getURL("control.html"),active:true}))()');
  const afterControl=await until(async()=>(await targets()).find(x=>
    x.type==='page'&&x.url==='chrome-extension://'+extensionId+'/control.html'&&x.webSocketDebuggerUrl),
    15000,'CONTROL_AFTER_RESTART');
  control=await Cdp.connect(afterControl.webSocketDebuggerUrl,'control-after-reload');
  await control.call('Runtime.enable');
  try {
    await until(()=>control.eval('document.readyState!=="loading"&&!!document.querySelector("#backgroundGrantList")'),
      12000,'CONTROL_AFTER_RESTART_READY');
  } catch(error) {
    const snapshot=await control.eval('JSON.stringify({href:location.href,title:document.title,readyState:document.readyState,'+
      'body:document.body?.innerText?.slice(0,800),grantList:!!document.querySelector("#backgroundGrantList"),'+
      'status:document.querySelector("#status")?.textContent})').catch(e=>String(e.message));
    const pageTargets=(await targets()).filter(x=>x.url==='chrome-extension://'+extensionId+'/control.html')
      .map(x=>({id:x.id,type:x.type,url:x.url,title:x.title,ws:!!x.webSocketDebuggerUrl}));
    throw Error(error.message+' CONTROL_PAGE='+snapshot+' CONTROL_TARGETS='+JSON.stringify(pageTargets));
  }
  const tabAAfter=await until(async()=>(await targets()).find(x=>x.type==='page'&&x.url==='https://claude.ai/chat/r4scenarioDA001'&&x.webSocketDebuggerUrl),15000,'TAB_A_AFTER_RESTART');
  pageA=await Cdp.connect(tabAAfter.webSocketDebuggerUrl,'provider-tab-a-after-reload');await pageA.call('Runtime.enable');
  const tabBAfter=await until(async()=>(await targets()).find(x=>x.type==='page'&&x.url==='https://claude.ai/chat/r4scenarioDB001'&&x.webSocketDebuggerUrl),15000,'TAB_B_AFTER_RESTART');
  pageB=await Cdp.connect(tabBAfter.webSocketDebuggerUrl,'provider-tab-b-after-reload');await pageB.call('Runtime.enable');

  // Restart the local test Bridge process as well. The provider journal is
  // reopened from the same stateDir/key; the unresolved COMMITTING record
  // must recover as UNKNOWN, never as SENT or retryable PREPARED.
  const oldBridge=bridge;
  bridge=null;
  const oldBridgeClosed=await Promise.race([
    new Promise(resolve=>{
      oldBridge.close(()=>resolve(true));
      oldBridge.closeAllConnections?.();
    }),
    sleep(10000).then(()=>false)
  ]);
  if(!oldBridgeClosed) {
    oldBridge.closeAllConnections?.();
    throw Error('BRIDGE_CLOSE_TIMEOUT_DURING_UNKNOWN_COMMIT_RECOVERY');
  }
  const lostCommit=await Promise.race([
    commitPromise.then(v=>({value:v}),e=>({transportError:e.message})),
    sleep(8000).then(()=>({timedOut:true}))
  ]);
  console.log('[R4 SCENARIO D LOST COMMIT CALL]',JSON.stringify(lostCommit));
  bridge=createBridge({browserToken,agentToken,extensionId},{timeout:120000,pollHold:500,settleMs:100,stateDir:state});
  await new Promise((r,j)=>{bridge.once('error',j);bridge.listen(17481,'127.0.0.1',r);});
  await until(async()=>(await rpc('browser_status')).connected===true,25000,'BRIDGE_RECONNECTED_AFTER_RESTART');

  const statusIdentity={
    requestId:identity.requestId,taskId:identity.taskId,providerId:identity.providerId,
    tabId:identity.tabId,origin:identity.origin,conversationId:identity.conversationId,epoch:identity.epoch
  };
  const recovered=await rpc('provider_status',statusIdentity);
  assert.equal(recovered.state,'UNKNOWN','the durable provider journal must recover the in-flight commit as UNKNOWN');
  assert.equal(recovered.clickedSend,undefined,'the journal must not claim a complete Send receipt');
  assert.ok(recovered.quarantineId,'unknown commit must carry a quarantine reference');
  const events=await rpc('provider_events',{after:0,limit:1000});
  const eventRows=Array.isArray(events)?events:(events.events||events.records||[]);
  const requestEvents=eventRows.filter(e=>e.requestId===identity.requestId);
  assert.ok(requestEvents.some(e=>e.state==='DISPATCHED'),
    'journal must persist the DISPATCHED commit.started state before the page click');
  assert.ok(!requestEvents.some(e=>e.state==='SENT'||e.state==='REPLIED'),
    'there must be no SENT or REPLIED receipt after the interrupted page action');

  // Replacement worker/control view must keep the grant store empty and
  // retain durable global pending fence + tab quarantine.
  await until(()=>control.eval('document.querySelector("#status").textContent.includes("Подключено")'),12000,'CONTROL_RECONNECTED');
  const coordinatorAfter=JSON.parse(await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"background-control-status"})))()'));
  assert.equal(coordinatorAfter.activeCount,0);assert.deepEqual(coordinatorAfter.grants,[]);
  assert.equal(coordinatorAfter.mutationEnabled,false);assert.equal(coordinatorAfter.approvalPending,0);
  const durableAfter=await control.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get(["bridgeMutationRevocationPending","bridgeMutationQuarantinedTabs","bridgeMutationLabMode"]),chrome.storage.session.get(["bridgeMutationRevocationPending","bridgeMutationQuarantinedTabs","bridgeBackgroundControlGrants"])]);return{localFence:l.bridgeMutationRevocationPending||null,sessionFence:s.bridgeMutationRevocationPending||null,localQuarantined:l.bridgeMutationQuarantinedTabs||[],sessionQuarantined:s.bridgeMutationQuarantinedTabs||[],localLab:l.bridgeMutationLabMode===true,sessionGrants:s.bridgeBackgroundControlGrants||{}}})()');
  assert.equal(durableAfter.localFence?.pending===true||durableAfter.sessionFence?.pending===true,true);
  assert.ok(durableAfter.localQuarantined.includes(tabs.a)||durableAfter.sessionQuarantined.includes(tabs.a));
  assert.equal(durableAfter.localLab,false);assert.deepEqual(durableAfter.sessionGrants,{});

  const pageAfterRestart={
    a:await pageA.eval('(()=>({draft:(document.querySelector("[contenteditable=true]")?.innerText||"").trim(),clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true",clickCount:document.querySelector("[data-testid=chat-input-send]")?.dataset.clickCount||"0"}))()'),
    b:await pageB.eval('(()=>({draft:(document.querySelector("[contenteditable=true]")?.innerText||"").trim(),clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true",clickCount:document.querySelector("[data-testid=chat-input-send]")?.dataset.clickCount||"0"}))()')
  };
  assert.equal(pageAfterRestart.a.clicked,true);assert.equal(pageAfterRestart.a.clickCount,'1');
  assert.equal(pageAfterRestart.b.draft,'');assert.equal(pageAfterRestart.b.clicked,false);

  // Re-enable only the disposable profile's lab flag to prove the durable
  // global fence, not merely the UI mode switch, rejects a stale post-restart
  // provider mutation. B has no Grant and remains a clean unrelated tab.
  await control.eval('window.confirm=()=>true;chrome.storage.local.set({bridgeMutationLabMode:true})');
  await until(()=>control.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get("bridgeMutationRevocationPending"),chrome.storage.session.get("bridgeMutationRevocationPending")]);return l.bridgeMutationRevocationPending?.pending===true||s.bridgeMutationRevocationPending?.pending===true})()'),5000,'GLOBAL_FENCE_STILL_PRESENT');
  const staleBind=await rpc('agent_bind',{name:'r4_d_stale_after_restart',tabId:tabs.b});
  await until(()=>pageB.eval('document.readyState==="complete"&&location.href==="https://claude.ai/chat/r4scenarioDB001"'),
    10000,'TAB_B_READY_FOR_STALE_FENCE_PROBE');
  const stalePeek=await rpc('agent_peek',{name:'r4_d_stale_after_restart',maxChars:100});
  const stale=make('r4Drequest0002','r4Dtask0002',tabs.b,'r4scenarioDB001',
    'This post-restart stale mutation must be blocked by durable global fence');
  const staleResult=await rpc('provider_prepare',stale);
  const coordinatorProbe=await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"background-control-status"})))()');
  console.log('[R4 D STALE REQUEST DIAGNOSTIC]',JSON.stringify({
    bind:staleBind,
    page:await pageB.eval('JSON.stringify({href:location.href,readyState:document.readyState,title:document.title})'),
    peek:{url:stalePeek.url,origin:stalePeek.origin,conversationId:stalePeek.conversationId,chars:stalePeek.chars},
    coordinator:JSON.parse(coordinatorProbe),
    result:staleResult
  }));
  assert.equal(staleResult.state,'BLOCKED');
  assert.equal(staleResult.reasonCode,'BACKGROUND_CONTROL_CLEAR_IN_PROGRESS',
    'the durable pending global Revoke fence must reject new mutations after restart');
  const finalPage=await pageB.eval('(()=>({draft:(document.querySelector("[contenteditable=true]")?.innerText||"").trim(),clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true"}))()');
  assert.equal(finalPage.draft,'');assert.equal(finalPage.clicked,false);

  // The operator recovery panel must not clear quarantine while the original
  // pageAction is still held after its one real fixture Send click.
  await until(()=>control.eval('document.querySelector("#quarantineList")?.textContent.includes("r4Drequest0001")'),15000,'QUARANTINE_UI_READY');
  assert.ok(await control.eval('!!document.querySelector("#quarantineList button")'),
    'the exact quarantined provider action must be exposed for operator review');
  await clickTrusted(control,'document.querySelector("#quarantineList button")');
  await until(()=>control.eval('document.querySelector("#quarantineRecoveryStatus")?.textContent.includes("QUARANTINE_")'),8000,'ACTIVE_ACTION_RECONCILIATION_DENIED');
  const stillQuarantined=await control.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get(["bridgeMutationQuarantinedTabs","bridgeMutationRevocationPending"]),chrome.storage.session.get(["bridgeMutationQuarantinedTabs","bridgeMutationRevocationPending"])]);return{localTabs:l.bridgeMutationQuarantinedTabs||[],sessionTabs:s.bridgeMutationQuarantinedTabs||[],localFence:l.bridgeMutationRevocationPending?.pending===true,sessionFence:s.bridgeMutationRevocationPending?.pending===true}})()');
  assert.ok(stillQuarantined.localTabs.includes(tabs.a)||stillQuarantined.sessionTabs.includes(tabs.a));
  assert.equal(stillQuarantined.localFence||stillQuarantined.sessionFence,true,
    'the global fence must remain while the original pageAction has not reached its terminal marker');

  // Release only the held receipt in the disposable fixture. The original
  // pageAction finally block writes its isolated-world terminal marker.
  await pageA.eval('document.documentElement.dataset.r4ReleaseCommitReceipt="true";true');
  await until(()=>pageA.eval('document.documentElement.dataset.r4CommitReceiptHeld!=="true"'),8000,'PAGE_ACTION_RECEIPT_RELEASED');
  const finallyReached=await until(()=>pageA.eval('document.documentElement.dataset.r4TestFinallyReached==="true"'),8000,'PAGE_ACTION_FINALLY_REACHED');
  assert.equal(finallyReached,true,'the original pageAction must reach its finally path after the held receipt is released');
  await until(()=>pageA.eval('document.documentElement.dataset.r4TestRuntimeMessage!==undefined'),8000,'PAGE_ACTION_RUNTIME_MESSAGE_SETTLED');
  await until(()=>control.eval('!!document.querySelector("#quarantineList button")'),10000,'QUARANTINE_RECONCILE_BUTTON_READY');
   const terminalEvidence=await control.eval('(async(tabId)=>{const q=await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"quarantine-status"});const stored=await chrome.storage.local.get("r4TestTerminalEvidence");const p=await chrome.scripting.executeScript({target:{tabId},world:"ISOLATED",func:()=>({terminal:globalThis.__chromeBridgeMutationTerminal||null,lock:globalThis.__chromeBridgeMutationLock||null,href:location.href,origin:location.origin})});return{record:q.records?.find(r=>r.tabId===tabId)||null,globalPending:q.globalPending||null,page:p?.[0]?.result||null,documentId:p?.[0]?.documentId||null,durableTestEvidence:stored.r4TestTerminalEvidence||null}})('+tabs.a+')');
  terminalEvidence.fixturePage=await pageA.eval('(()=>({held:document.documentElement.dataset.r4CommitReceiptHeld||null,release:document.documentElement.dataset.r4ReleaseCommitReceipt||null,finallyReached:document.documentElement.dataset.r4TestFinallyReached||null,runtimeMessage:document.documentElement.dataset.r4TestRuntimeMessage||null}))()');
  terminalEvidence.durableTestEvidence=await control.eval('(async()=>{const r=await chrome.storage.local.get("r4TestTerminalEvidence");return r.r4TestTerminalEvidence||null})()');
  assert.equal(terminalEvidence.fixturePage.runtimeMessage,'ok',
    'the original isolated-world action must receive a successful background acknowledgement');
  assert.ok(terminalEvidence.durableTestEvidence,'background must persist terminal evidence');
  assert.equal(terminalEvidence.durableTestEvidence.tabId,tabs.a);
  assert.equal(terminalEvidence.durableTestEvidence.frameId,0);
  assert.equal(terminalEvidence.durableTestEvidence.documentId,terminalEvidence.record.documentId);
  assert.equal(terminalEvidence.durableTestEvidence.evidence.requestId,terminalEvidence.record.requestId);
  assert.equal(terminalEvidence.durableTestEvidence.evidence.state,'COMMIT_CLICK_ATTEMPTED');
  assert.equal(terminalEvidence.durableTestEvidence.evidence.clickAttempted,true);
  console.log('[R4 D TERMINAL EVIDENCE DIAGNOSTIC]',JSON.stringify(terminalEvidence));
  await clickTrusted(control,'document.querySelector("#quarantineList button")');
  await until(async()=>{
    const status=await control.eval('document.querySelector("#quarantineRecoveryStatus")?.textContent||""');
    if(status.includes('UNKNOWN; повтор не выполнялся'))return true;
    if(status.startsWith('Карантин сохранён:'))
      throw Error('OPERATOR_RECONCILIATION_REJECTED:'+status);
    return false;
  },10000,'OPERATOR_RECONCILIATION_COMPLETE');

  const reconciledStorage=await control.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get(["bridgeMutationQuarantinedTabs","bridgeMutationQuarantineRecords","bridgeMutationQuarantineAudit","bridgeMutationRevocationPending"]),chrome.storage.session.get(["bridgeMutationQuarantinedTabs","bridgeMutationQuarantineRecords","bridgeMutationQuarantineAudit","bridgeMutationRevocationPending"])]);return{localTabs:l.bridgeMutationQuarantinedTabs||[],sessionTabs:s.bridgeMutationQuarantinedTabs||[],localRecords:l.bridgeMutationQuarantineRecords||{},sessionRecords:s.bridgeMutationQuarantineRecords||{},localAudit:l.bridgeMutationQuarantineAudit||[],sessionAudit:s.bridgeMutationQuarantineAudit||[],localFence:l.bridgeMutationRevocationPending||null,sessionFence:s.bridgeMutationRevocationPending||null}})()');
  assert.deepEqual(reconciledStorage.localTabs,[]);
  assert.deepEqual(reconciledStorage.sessionTabs,[]);
  assert.deepEqual(reconciledStorage.localRecords,{});
  assert.deepEqual(reconciledStorage.sessionRecords,{});
  assert.equal(reconciledStorage.localFence,null);
  assert.equal(reconciledStorage.sessionFence,null);
  assert.ok(reconciledStorage.localAudit.some(e=>e.type==='OPERATOR_RECONCILE'&&
    e.requestId===identity.requestId&&typeof e.globalFenceToken==='string'));
  assert.ok(reconciledStorage.sessionAudit.some(e=>e.type==='OPERATOR_RECONCILE'&&
    e.requestId===identity.requestId&&typeof e.globalFenceToken==='string'));

  // Reconciliation changes only tab admission/quarantine. It must never rewrite
  // the provider journal's UNKNOWN delivery outcome or send a second click.
  const stillUnknown=await rpc('provider_status',statusIdentity);
  assert.equal(stillUnknown.state,'UNKNOWN');
  assert.equal(stillUnknown.clickedSend,undefined);
  const noDuplicateClick=await pageA.eval('(()=>({buttonCount:document.querySelector("[data-testid=chat-input-send]")?.dataset.clickCount||"0",clickCount:document.documentElement.dataset.r4CommitClickCount||"0"}))()');
  assert.equal(noDuplicateClick.buttonCount,'1');
  assert.equal(noDuplicateClick.clickCount,'1');
  console.log('[R4 SCENARIO D PASS] Send clicked once; receipt lost; Revoke UNKNOWN/quarantined; MV3 + Bridge restart; operator reconciliation required terminal evidence; UNKNOWN retained; no replay or duplicate click');
 }finally{
  clearTimeout(watchdog);
  control?.close();pageA?.close();pageB?.close();worker?.close();
  for(const socket of sockets)socket.destroy();
  if(chrome&&chrome.exitCode===null){
    try{process.kill(-chrome.pid,'SIGKILL');}catch{try{chrome.kill('SIGKILL');}catch{}}
    await Promise.race([new Promise(resolve=>chrome.once('exit',resolve)),sleep(2500)]);
  }
  const closeServer=async server=>{
    if(!server?.listening)return;
    const closed=new Promise(resolve=>{try{server.close(()=>resolve());}catch{resolve();}});
    try{server.closeAllConnections?.();}catch{}
    await Promise.race([closed,sleep(2500)]);
  };
  await closeServer(bridge);await closeServer(tls);await closeServer(proxy);
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch(e){console.warn('[R4 D] fixture cleanup deferred',e.code);}
 }
});
