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
const until=async(fn,ms,label)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e.message;}await sleep(150);}throw Error('R4_D_'+label+'_TIMEOUT '+(last||''));};
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
test('R4 Scenario D: interrupted provider_commit remains UNKNOWN and quarantined after MV3/Bridge restart',{timeout:300000},async()=>{
 const browser=process.env.CHROME_BIN;assert.ok(browser&&fs.existsSync(browser),'CHROME_FOR_TESTING_REQUIRED');
 const xvfb=spawnSync('which',['xvfb-run'],{encoding:'utf8'});assert.equal(xvfb.status,0,'XVFB_REQUIRED');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-r4-d-')),ext=path.join(dir,'extension'),profile=path.join(dir,'profile'),state=path.join(dir,'state');
 fs.mkdirSync(ext);fs.mkdirSync(profile);fs.mkdirSync(path.join(profile,'Default'),{recursive:true});
 fs.writeFileSync(path.join(profile,'Default','Preferences'),JSON.stringify({extensions:{ui:{developer_mode:true}}}));
 for(const n of fs.readdirSync(new URL('../extension/',import.meta.url))){const src=new URL('../extension/'+n,import.meta.url);if(/\.(js|html|css)$/.test(n)&&fs.statSync(src).isFile())fs.writeFileSync(path.join(ext,n),fs.readFileSync(src,'utf8').replaceAll('http://127.0.0.1:17381','http://127.0.0.1:17481'));}
 // Test-only receipt hold in the disposable extension copy. The real
 // provider_commit click happens first; only its post-click receipt is held,
 // reproducing an uncertain in-flight side effect during worker/Bridge restart.
 const pageActionPath=path.join(ext,'page.js');
 let pageActionSource=fs.readFileSync(pageActionPath,'utf8');
 const commitClickMarker='      sendButtons[0].click();\n      const clickedAt = new Date().toISOString();';
 const commitClickHook=`      sendButtons[0].click();
      document.documentElement.dataset.r4CommitClickCount =
        String(Number(document.documentElement.dataset.r4CommitClickCount || '0') + 1);
      if (document.documentElement.dataset.r4HoldCommitReceipt === 'true') {
        document.documentElement.dataset.r4CommitReceiptHeld = 'true';
        await new Promise(resolve => {
          const timer = setInterval(() => {
            if (document.documentElement.dataset.r4ReleaseCommitReceipt === 'true') {
              clearInterval(timer);
              resolve();
            }
          }, 10);
        });
      }
      const clickedAt = new Date().toISOString();`;
 assert.ok(pageActionSource.includes(commitClickMarker),'PROVIDER_COMMIT_HOOK_MARKER_MISSING');
 pageActionSource=pageActionSource.replace(commitClickMarker,commitClickHook);
 fs.writeFileSync(pageActionPath,pageActionSource);
 const extensionId=[...crypto.createHash('sha256').update(path.resolve(ext)).digest('hex').slice(0,32)].map(c=>'abcdefghijklmnop'[parseInt(c,16)]).join('');
 const browserToken=crypto.randomBytes(32).toString('hex'),agentToken=crypto.randomBytes(32).toString('hex');
 fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'R4 Scenario D',version:'0.2.0',background:{service_worker:'background.js',type:'module'},action:{default_title:'R4 D'},permissions:['storage','scripting','tabs','offscreen','alarms'],host_permissions:['http://127.0.0.1:17481/*','https://claude.ai/*']}));
 const key=path.join(dir,'key.pem'),crt=path.join(dir,'cert.pem');
 const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',crt,'-days','1','-subj','/CN=claude.ai','-addext','subjectAltName=DNS:claude.ai'],{encoding:'utf8'});assert.equal(cert.status,0,'TLS_FIXTURE_CERT_FAILED');
 const html='<!doctype html><html><body><div class="font-claude-response">Fixture baseline</div><div contenteditable="true" class="ProseMirror" role="textbox" style="min-height:42px;min-width:240px;border:1px solid #777"></div><button type="button" data-testid="chat-input-send">Send</button><script>document.querySelector("button").addEventListener("click",e=>{e.currentTarget.dataset.clicked="true";e.currentTarget.dataset.clickCount=String(Number(e.currentTarget.dataset.clickCount||"0")+1)})</script></body></html>';
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
  const seed='(async()=>{await chrome.storage.local.set({browserToken:'+JSON.stringify(browserToken)+',bridgeBackgroundMode:true,bridgeConnectionDesired:true,bridgeMutationLabMode:true,sites:{"https://claude.ai":{mode:"chat",adapter:"claude"}},adapters:"{}"});const a=await chrome.tabs.create({url:"https://claude.ai/chat/r4scenarioDA001",active:false});const b=await chrome.tabs.create({url:"https://claude.ai/chat/r4scenarioDB001",active:false});const c=await chrome.tabs.create({url:chrome.runtime.getURL("control.html"),active:true});return{a:a.id,b:b.id,c:c.id};})()';
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
  const aBind=await rpc('agent_bind',{name:'r4_d_inflight',tabId:tabs.a});
  const bBind=await rpc('agent_bind',{name:'r4_d_stale',tabId:tabs.b});
  assert.equal(aBind.adapterVerified,true);assert.equal(bBind.adapterVerified,true);
  const make=(requestId,taskId,tabId,conversationId,message)=>({
    requestId,taskId,providerId:'claude',tabId,origin:'https://claude.ai',
    conversationId,epoch:1,message,payloadHash:crypto.createHash('sha256').update(message).digest('hex')
  });
  const identity=make('r4Drequest0001','r4Dtask0001',tabs.a,'r4scenarioDA001',
    'Scenario D commit will be clicked once, then its receipt is deliberately lost');
  const prepareResult=await rpc('provider_prepare',identity);
  assert.equal(prepareResult.state,'PENDING_APPROVAL');
  await until(()=>control.eval('document.querySelectorAll("#backgroundApprovals .approval").length===1'),15000,'PREPARE_APPROVAL');
  assert.ok((await control.eval('document.querySelector("#backgroundApprovals .approval").textContent')).includes(String(tabs.a)));
  const approvePrepare='[...document.querySelectorAll("#backgroundApprovals .approval")].find(e=>e.textContent.includes('+JSON.stringify(String(tabs.a))+'))?.querySelector("button:not(.danger)")';
  await clickTrusted(control,approvePrepare);
  const prepared=await Promise.race([
    prepareResult.state==='PREPARED'?Promise.resolve(prepareResult):sleep(100).then(()=>rpc('provider_status',identity)),
    sleep(30000).then(()=>{throw Error('D_PREPARE_NOT_COMPLETED');})
  ]);
  let preparedResult=prepared;
  if(preparedResult.state!=='PREPARED')
    preparedResult=await until(async()=>{const s=await rpc('provider_status',identity);return s.state==='PREPARED'?s:null;},20000,'PREPARED_STATUS');
  assert.equal(preparedResult.state,'PREPARED');
  assert.equal(preparedResult.sideEffect,'composer-filled-no-send');
  assert.equal(preparedResult.clickedSend,false);
  assert.ok(preparedResult.preparedId&&preparedResult.fencingToken);

  // Arm the hold inside the real Claude page fixture before provider_commit.
  await worker.eval('(async()=>chrome.scripting.executeScript({target:{tabId:'+tabs.a+'},func:()=>{document.documentElement.dataset.r4HoldCommitReceipt="true";document.documentElement.dataset.r4CommitReceiptHeld="false";document.documentElement.dataset.r4CommitClickCount="0";return true}}))()');
  const commitArgs={requestId:identity.requestId,taskId:identity.taskId,providerId:identity.providerId,
    tabId:identity.tabId,origin:identity.origin,conversationId:identity.conversationId,epoch:identity.epoch,
    preparedId:preparedResult.preparedId,fencingToken:preparedResult.fencingToken,payloadHash:identity.payloadHash};
  const commitPromise=rpc('provider_commit',commitArgs);
  await until(()=>control.eval('document.querySelectorAll("#backgroundApprovals .approval").length===1'),15000,'COMMIT_APPROVAL');
  assert.ok((await control.eval('document.querySelector("#backgroundApprovals .approval").textContent')).includes(String(tabs.a)));
  const approveCommit='[...document.querySelectorAll("#backgroundApprovals .approval")].find(e=>e.textContent.includes('+JSON.stringify(String(tabs.a))+'))?.querySelector("button:not(.danger)")';
  await clickTrusted(control,approveCommit);
  await until(async()=>worker.eval('(async()=>{const r=await chrome.scripting.executeScript({target:{tabId:'+tabs.a+'},func:()=>({clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true",count:document.documentElement.dataset.r4CommitClickCount,held:document.documentElement.dataset.r4CommitReceiptHeld==="true"})});return r?.[0]?.result?.clicked===true&&r?.[0]?.result?.held===true&&r?.[0]?.result?.count==="1"})()'),20000,'SEND_CLICK_RECEIPT_HELD');

  const sendState=await worker.eval('(async()=>{const r=await chrome.scripting.executeScript({target:{tabId:'+tabs.a+'},func:()=>({clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true",buttonCount:document.querySelector("[data-testid=chat-input-send]")?.dataset.clickCount||"0",hold:document.documentElement.dataset.r4CommitReceiptHeld==="true"})});return r?.[0]?.result})()');
  assert.equal(sendState.clicked,true);assert.equal(sendState.buttonCount,'1');assert.equal(sendState.hold,true);

  // Global Revoke must time out draining the deliberately held accepted
  // mutation, clear all grants, and durably quarantine the affected tab.
  await control.eval('window.__r4GlobalRevokeTrusted=null;document.querySelector("#backgroundRevokeAll").addEventListener("click",e=>window.__r4GlobalRevokeTrusted=e.isTrusted,{capture:true})');
  await clickTrusted(control,'document.querySelector("#backgroundRevokeAll")');
  await until(()=>control.eval('window.__r4GlobalRevokeTrusted===true'),3000,'GLOBAL_REVOKE_TRUSTED');
  await until(()=>control.eval('document.querySelector("#backgroundGrantStatus").textContent.includes("Ошибка отключения: UNKNOWN: BACKGROUND_STOP_UNCONFIRMED")'),20000,'GLOBAL_REVOKE_UNKNOWN');
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
  try { await worker.eval('chrome.runtime.reload();true'); } catch {}
  worker.close();worker=null;
  const restartedWorker=await until(async()=>(await targets()).find(x=>x.type==='service_worker'&&x.url==='chrome-extension://'+extensionId+'/background.js'&&x.webSocketDebuggerUrl),20000,'WORKER_AFTER_INFLIGHT_RELOAD');
  worker=await Cdp.connect(restartedWorker.webSocketDebuggerUrl);await worker.call('Runtime.enable');
  await until(()=>worker.eval('!!chrome.storage?.local&&!!chrome.runtime?.id'),10000,'RESTARTED_WORKER_API');
  await worker.eval('(async()=>chrome.tabs.create({url:chrome.runtime.getURL("control.html"),active:true}))()');

  // Restart the local test Bridge process as well. The provider journal is
  // reopened from the same stateDir/key; the unresolved COMMITTING record
  // must recover as UNKNOWN, never as SENT or retryable PREPARED.
  const oldBridge=bridge;
  await new Promise(resolve=>{
    oldBridge.close(resolve);
    oldBridge.closeAllConnections?.();
  });
  bridge=null;
  const lostCommit=await Promise.race([
    commitPromise.then(v=>({value:v}),e=>({transportError:e.message})),
    sleep(8000).then(()=>({timedOut:true}))
  ]);
  console.log('[R4 SCENARIO D LOST COMMIT CALL]',JSON.stringify(lostCommit));
  bridge=createBridge({browserToken,agentToken,extensionId},{timeout:120000,pollHold:500,settleMs:100,stateDir:state});
  await new Promise((r,j)=>{bridge.once('error',j);bridge.listen(17481,'127.0.0.1',r);});
  await until(async()=>(await rpc('browser_status')).connected===true,25000,'BRIDGE_RECONNECTED_AFTER_RESTART');

  const recovered=await rpc('provider_status',identity);
  assert.equal(recovered.state,'UNKNOWN','the durable provider journal must recover the in-flight commit as UNKNOWN');
  assert.equal(recovered.clickedSend,undefined,'the journal must not claim a complete Send receipt');
  assert.ok(recovered.quarantineId,'unknown commit must carry a quarantine reference');
  const events=await rpc('provider_events',{after:0,limit:1000});
  const eventRows=Array.isArray(events)?events:(events.events||events.records||[]);
  assert.ok(eventRows.some(e=>e.type==='commit.started'||e.event==='commit.started'),
    'journal must persist commit.started before the page click');
  assert.ok(!eventRows.some(e=>e.type==='commit.completed'||e.event==='commit.completed'),
    'there must be no commit.completed receipt after the interrupted page action');

  // Replacement worker/control view must keep the grant store empty and
  // retain durable global pending fence + tab quarantine.
  const afterControl=await until(async()=>(await targets()).find(x=>x.type==='page'&&x.url==='chrome-extension://'+extensionId+'/control.html'&&x.webSocketDebuggerUrl),15000,'CONTROL_AFTER_RESTART');
  control=await Cdp.connect(afterControl.webSocketDebuggerUrl);await control.call('Runtime.enable');
  await until(()=>control.eval('document.readyState!=="loading"&&!!document.querySelector("#backgroundGrantList")'),12000,'CONTROL_AFTER_RESTART_READY');
  await until(()=>control.eval('document.querySelector("#status").textContent.includes("Подключено")'),12000,'CONTROL_RECONNECTED');
  const coordinatorAfter=JSON.parse(await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"background-control-status"})))()'));
  assert.equal(coordinatorAfter.activeCount,0);assert.deepEqual(coordinatorAfter.grants,[]);
  assert.equal(coordinatorAfter.mutationEnabled,false);assert.equal(coordinatorAfter.approvalPending,0);
  const durableAfter=await worker.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get(["bridgeMutationRevocationPending","bridgeMutationQuarantinedTabs","bridgeMutationLabMode"]),chrome.storage.session.get(["bridgeMutationRevocationPending","bridgeMutationQuarantinedTabs","bridgeBackgroundControlGrants"])]);return{localFence:l.bridgeMutationRevocationPending||null,sessionFence:s.bridgeMutationRevocationPending||null,localQuarantined:l.bridgeMutationQuarantinedTabs||[],sessionQuarantined:s.bridgeMutationQuarantinedTabs||[],localLab:l.bridgeMutationLabMode===true,sessionGrants:s.bridgeBackgroundControlGrants||{}}})()');
  assert.equal(durableAfter.localFence?.pending===true||durableAfter.sessionFence?.pending===true,true);
  assert.ok(durableAfter.localQuarantined.includes(tabs.a)||durableAfter.sessionQuarantined.includes(tabs.a));
  assert.equal(durableAfter.localLab,false);assert.deepEqual(durableAfter.sessionGrants,{});

  const pageAfterRestart=await worker.eval('(async()=>{const out=await Promise.all(['+tabs.a+','+tabs.b+'].map(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>({draft:(document.querySelector("[contenteditable=true]")?.innerText||"").trim(),clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true",clickCount:document.querySelector("[data-testid=chat-input-send]")?.dataset.clickCount||"0"})})));return{a:out[0][0].result,b:out[1][0].result}})()');
  assert.equal(pageAfterRestart.a.clicked,true);assert.equal(pageAfterRestart.a.clickCount,'1');
  assert.equal(pageAfterRestart.b.draft,'');assert.equal(pageAfterRestart.b.clicked,false);

  // Re-enable only the disposable profile's lab flag to prove the durable
  // global fence, not merely the UI mode switch, rejects a stale post-restart
  // provider mutation. B has no Grant and remains a clean unrelated tab.
  await worker.eval('chrome.storage.local.set({bridgeMutationLabMode:true})');
  await until(()=>worker.eval('chrome.storage.local.get("bridgeMutationRevocationPending").then(x=>x.bridgeMutationRevocationPending?.pending===true)'),5000,'GLOBAL_FENCE_STILL_PRESENT');
  await rpc('agent_bind',{name:'r4_d_stale_after_restart',tabId:tabs.b});
  const stale=make('r4Drequest0002','r4Dtask0002',tabs.b,'r4scenarioDB001',
    'This post-restart stale mutation must be blocked by durable global fence');
  const staleResult=await rpc('provider_prepare',stale);
  assert.equal(staleResult.state,'BLOCKED');
  assert.equal(staleResult.reasonCode,'BACKGROUND_CONTROL_CLEAR_IN_PROGRESS',
    'the durable pending global Revoke fence must reject new mutations after restart');
  const finalPage=await worker.eval('(async()=>{const out=await chrome.scripting.executeScript({target:{tabId:'+tabs.b+'},func:()=>({draft:(document.querySelector("[contenteditable=true]")?.innerText||"").trim(),clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true"})});return out?.[0]?.result})()');
  assert.equal(finalPage.draft,'');assert.equal(finalPage.clicked,false);
  console.log('[R4 SCENARIO D PASS] Send clicked once; receipt lost; Revoke returned UNKNOWN and quarantined A; MV3 + Bridge restarted; journal UNKNOWN; grants never reappeared; stale post-restart mutation BLOCKED by durable global fence');
 }finally{
  control?.close();worker?.close();
  if(chrome&&!chrome.killed){try{process.kill(-chrome.pid,'SIGTERM');}catch{chrome.kill('SIGTERM');}}
  if(bridge?.listening)await new Promise(r=>bridge.close(r));
  if(tls.listening)await new Promise(r=>tls.close(r));
  if(proxy?.listening)await new Promise(r=>proxy.close(r));
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch(e){console.warn('[R4 D] fixture cleanup deferred',e.code);}
 }
});
