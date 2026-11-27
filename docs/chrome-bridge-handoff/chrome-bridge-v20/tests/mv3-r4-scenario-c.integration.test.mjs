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
const until=async(fn,ms,label)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e.message;}await sleep(150);}throw Error('R4_C_'+label+'_TIMEOUT '+(last||''));};
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
test('R4 Scenario C: ten real MV3 late-approval races are fenced before Approval registration',{timeout:300000},async()=>{
 const browser=process.env.CHROME_BIN;assert.ok(browser&&fs.existsSync(browser),'CHROME_FOR_TESTING_REQUIRED');
 const xvfb=spawnSync('which',['xvfb-run'],{encoding:'utf8'});assert.equal(xvfb.status,0,'XVFB_REQUIRED');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-r4-c-')),ext=path.join(dir,'extension'),profile=path.join(dir,'profile'),state=path.join(dir,'state');
 fs.mkdirSync(ext);fs.mkdirSync(profile);fs.mkdirSync(path.join(profile,'Default'),{recursive:true});
 fs.writeFileSync(path.join(profile,'Default','Preferences'),JSON.stringify({extensions:{ui:{developer_mode:true}}}));
 for(const n of fs.readdirSync(new URL('../extension/',import.meta.url))){const src=new URL('../extension/'+n,import.meta.url);if(/\.(js|html|css)$/.test(n)&&fs.statSync(src).isFile())fs.writeFileSync(path.join(ext,n),fs.readFileSync(src,'utf8').replaceAll('http://127.0.0.1:17381','http://127.0.0.1:17481'));}
 // Deterministic race gate exists ONLY in this temporary extension copy.
 // It delays the real agent_context preflight result; coordinator,
 // dispatcher, ApprovalSession and Grant/Revoke paths remain untouched.
 const pageActionPath=path.join(ext,'page.js');
 let pageActionSource=fs.readFileSync(pageActionPath,'utf8');
 const agentContextMarker='    if (name === \'agent_context\') return { verified: !!conversationId(), origin: location.origin, conversationId: conversationId() };';
 const agentContextHook=`    if (name === 'agent_context') {
      const r4ContextCalls = Number(document.documentElement.dataset.r4AgentContextCallCount || '0') + 1;
      document.documentElement.dataset.r4AgentContextCallCount = String(r4ContextCalls);
      // MCP's server-side identity preflight is call 1. Pause call 2, which
      // is the actual provider mutation dispatch preflight immediately before
      // ApprovalSession registration.
      if (document.documentElement.dataset.r4PauseAgentContext === 'true' && r4ContextCalls === 2) {
        document.documentElement.dataset.r4AgentContextEntered = 'true';
        await new Promise(resolve => {
          const timer = setInterval(() => {
            if (document.documentElement.dataset.r4ReleaseAgentContext === 'true') {
              clearInterval(timer);
              resolve();
            }
          }, 10);
        });
      }
      return { verified: !!conversationId(), origin: location.origin, conversationId: conversationId() };
    }`;
 assert.ok(pageActionSource.includes(agentContextMarker),'AGENT_CONTEXT_HOOK_MARKER_MISSING');
 pageActionSource=pageActionSource.replace(agentContextMarker,agentContextHook);
 fs.writeFileSync(pageActionPath,pageActionSource);
 const extensionId=[...crypto.createHash('sha256').update(path.resolve(ext)).digest('hex').slice(0,32)].map(c=>'abcdefghijklmnop'[parseInt(c,16)]).join('');
 const browserToken=crypto.randomBytes(32).toString('hex'),agentToken=crypto.randomBytes(32).toString('hex');
 fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'R4 Scenario C',version:'0.2.0',background:{service_worker:'background.js',type:'module'},action:{default_title:'R4 C'},permissions:['storage','scripting','tabs','offscreen','alarms'],host_permissions:['http://127.0.0.1:17481/*','https://claude.ai/*']}));
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
  const seed='(async()=>{await chrome.storage.local.set({browserToken:'+JSON.stringify(browserToken)+',bridgeBackgroundMode:true,bridgeConnectionDesired:true,bridgeMutationLabMode:true,sites:{"https://claude.ai":{mode:"chat",adapter:"claude"}},adapters:"{}"});const a=await chrome.tabs.create({url:"https://claude.ai/chat/r4scenarioC001",active:false});const c=await chrome.tabs.create({url:chrome.runtime.getURL("control.html"),active:true});return{a:a.id,c:c.id};})()';
  const tabs=await worker.eval(seed);
  const ct=await until(async()=>(await targets()).find(x=>x.type==='page'&&x.url==='chrome-extension://'+extensionId+'/control.html'&&x.webSocketDebuggerUrl),15000,'CONTROL');
  control=await Cdp.connect(ct.webSocketDebuggerUrl);await control.call('Runtime.enable');
  await until(()=>control.eval('document.readyState==="complete"&&!!document.querySelector("#backgroundGrantAll")'),12000,'CONTROL_READY');
  await control.eval('window.confirm=()=>true');
  await until(async()=>(await rpc('browser_status')).connected===true,20000,'CONNECTED');
  await until(()=>control.eval('document.querySelector("#status").textContent.includes("Подключено")'),10000,'CONTROL_CONNECTED');
  await until(()=>control.eval('document.querySelector("#mutationLab").checked===true'),8000,'LAB_ON');
  const binding=await rpc('agent_bind',{name:'r4_late_race',tabId:tabs.a});
  assert.equal(binding.adapterVerified,true);
  const make=(attempt,message)=>({requestId:'r4late'+String(attempt).padStart(4,'0'),taskId:'r4latetask'+String(attempt).padStart(4,'0'),providerId:'claude',tabId:tabs.a,origin:'https://claude.ai',conversationId:'r4scenarioC001',epoch:1,message,payloadHash:crypto.createHash('sha256').update(message).digest('hex')});
  await control.eval('window.__r4GrantClickTrusted=null;document.querySelector("#backgroundGrantAll").addEventListener("click",e=>window.__r4GrantClickTrusted=e.isTrusted,{capture:true})');
  await control.eval('document.querySelector("#backgroundGrantList").addEventListener("click",e=>{if(e.target?.tagName==="BUTTON")window.__r4RevokeClickTrusted=e.isTrusted},{capture:true})');

  const readFence=async()=>worker.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get("bridgeMutationRevokingTabs"),chrome.storage.session.get("bridgeMutationRevokingTabs")]);return{local:Array.isArray(l.bridgeMutationRevokingTabs)?l.bridgeMutationRevokingTabs:[],session:Array.isArray(s.bridgeMutationRevokingTabs)?s.bridgeMutationRevokingTabs:[]}})()');
  const grantTab=async attempt=>{
    await control.eval('window.__r4GrantClickTrusted=null');
    await clickTrusted(control,'document.querySelector("#backgroundGrantAll")');
    await until(()=>control.eval('window.__r4GrantClickTrusted===true'),3000,'GRANT_TRUSTED_'+attempt);
    await until(async()=>control.eval('(()=>{const rows=[...document.querySelectorAll("#backgroundGrantList .approval")];return rows.length===1&&rows[0].textContent.includes('+JSON.stringify(String(tabs.a))+')})()'),10000,'GRANT_CREATED_'+attempt);
  };

  const attempts=10;
  for(let attempt=1;attempt<=attempts;attempt++){
    await grantTab(attempt);
    await worker.eval('(async()=>chrome.scripting.executeScript({target:{tabId:'+tabs.a+'},func:()=>{document.documentElement.dataset.r4PauseAgentContext="true";document.documentElement.dataset.r4AgentContextCallCount="0";document.documentElement.dataset.r4AgentContextEntered="false";document.documentElement.dataset.r4ReleaseAgentContext="false";return true}}))()');
    const message='Late approval race must fail closed; iteration '+attempt;
    const args=make(attempt,message);
    const preparePromise=rpc('provider_prepare',args);
    await until(async()=>worker.eval('(async()=>{const r=await chrome.scripting.executeScript({target:{tabId:'+tabs.a+'},func:()=>document.documentElement.dataset.r4AgentContextEntered==="true"&&document.documentElement.dataset.r4AgentContextCallCount==="2"});return r?.[0]?.result===true})()'),10000,'PREFLIGHT_PAUSED_'+attempt);

    await control.eval('window.__r4RevokeClickTrusted=null');
    const revokeExpr='[...document.querySelectorAll("#backgroundGrantList .approval")].find(e=>e.textContent.includes('+JSON.stringify(String(tabs.a))+'))?.querySelector("button")';
    await clickTrusted(control,revokeExpr);
    await until(()=>control.eval('window.__r4RevokeClickTrusted===true'),3000,'REVOKE_TRUSTED_'+attempt);

    const fence=await until(async()=>{
      const state=await readFence();
      return state.local.includes(tabs.a)||state.session.includes(tabs.a) ? state : null;
    },8000,'DURABLE_FENCE_'+attempt);
    assert.ok(fence.local.includes(tabs.a)||fence.session.includes(tabs.a),
      'per-tab durable fence must be visible before releasing the paused preflight');

    await worker.eval('(async()=>chrome.scripting.executeScript({target:{tabId:'+tabs.a+'},func:()=>{document.documentElement.dataset.r4ReleaseAgentContext="true";return true}}))()');
    const result=await Promise.race([
      preparePromise,
      sleep(15000).then(()=>{throw Error('PREPARE_NOT_BLOCKED_'+attempt);})
    ]);
    assert.equal(result.state,'BLOCKED','late Approval registration must be rejected after Revoke fences the tab');
    assert.equal(result.reasonCode,'TAB_MUTATION_REVOKING','the coordinator fence must be the reason late Approval was denied');

    await until(()=>control.eval('document.querySelector("#backgroundGrantStatus").textContent.includes("Разрешение вкладки '+String(tabs.a)+' отозвано")'),12000,'REVOKE_COMPLETED_'+attempt);
    await until(()=>control.eval('document.querySelectorAll("#backgroundGrantList .approval").length===0'),5000,'GRANT_REMOVED_'+attempt);

    const approvalState=JSON.parse(await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"approval-list"})))()'));
    assert.deepEqual(approvalState.pending,[],'no late approval may be registered after Revoke');
    const status=JSON.parse(await control.eval('(async()=>JSON.stringify(await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"background-control-status"})))()'));
    assert.equal(status.activeCount,0);assert.deepEqual(status.grants,[]);assert.equal(status.approvalPending,0);

    const pageState=await worker.eval('(async()=>{const out=await chrome.scripting.executeScript({target:{tabId:'+tabs.a+'},func:()=>({draft:(document.querySelector("[contenteditable=true]")?.innerText||"").trim(),clicked:document.querySelector("[data-testid=chat-input-send]")?.dataset.clicked==="true"})});return out?.[0]?.result})()');
    assert.equal(pageState.draft,'','late preflight must not fill the provider composer');
    assert.equal(pageState.clicked,false,'late preflight must not click Send');

    const durable=await worker.eval('(async()=>{const [l,s]=await Promise.all([chrome.storage.local.get(["bridgeMutationRevokingTabs","bridgeMutationQuarantinedTabs","bridgeMutationQuarantineLock"]),chrome.storage.session.get(["bridgeMutationRevokingTabs","bridgeMutationQuarantinedTabs","bridgeMutationQuarantineLock","bridgeBackgroundControlGrants"])]);return{localRevoking:l.bridgeMutationRevokingTabs||[],sessionRevoking:s.bridgeMutationRevokingTabs||[],localQuarantined:l.bridgeMutationQuarantinedTabs||[],sessionQuarantined:s.bridgeMutationQuarantinedTabs||[],quarantineLock:l.bridgeMutationQuarantineLock===true||s.bridgeMutationQuarantineLock===true,grants:s.bridgeBackgroundControlGrants||{}}})()');
    assert.ok(!durable.localRevoking.includes(tabs.a));assert.ok(!durable.sessionRevoking.includes(tabs.a));
    assert.ok(!durable.localQuarantined.includes(tabs.a));assert.ok(!durable.sessionQuarantined.includes(tabs.a));
    assert.equal(durable.quarantineLock,false);assert.deepEqual(durable.grants,{});
    console.log('[R4 SCENARIO C ATTEMPT PASS] '+attempt+'/'+attempts+' late preflight rejected before Approval; Revoke completed; no page mutation');
  }
  console.log('[R4 SCENARIO C PASS] '+attempts+' consecutive late-approval races denied by the per-tab fence; no late Approval, draft or Send clicks');
 }finally{
  control?.close();worker?.close();
  if(chrome&&!chrome.killed){try{process.kill(-chrome.pid,'SIGTERM');}catch{chrome.kill('SIGTERM');}}
  if(bridge?.listening)await new Promise(r=>bridge.close(r));
  if(tls.listening)await new Promise(r=>tls.close(r));
  if(proxy?.listening)await new Promise(r=>proxy.close(r));
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch(e){console.warn('[R4 C] fixture cleanup deferred',e.code);}
 }
});
