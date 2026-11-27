import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
class Cdp {
  constructor(ws) {
    this.ws=ws;this.sequence=0;this.pending=new Map();
    const failPending=reason=>{
      for(const [id,pending] of this.pending){
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(Error('CDP_SOCKET_CLOSED '+reason));
      }
    };
    ws.addEventListener('message',event=>{
      let message;
      try{message=JSON.parse(event.data);}catch{return;}
      if(!message.id)return;
      const pending=this.pending.get(message.id);
      if(!pending)return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error?pending.reject(Error(JSON.stringify(message.error))):pending.resolve(message.result);
    });
    ws.addEventListener('close',()=>failPending('close'));
    ws.addEventListener('error',()=>failPending('error'));
  }
  static async connect(url,label='target') {
    const ws=new WebSocket(url);
    await new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error)=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        error?reject(error):resolve();
      };
      const timer=setTimeout(()=>{
        try{ws.close();}catch{}
        finish(Error('CDP_CONNECT_TIMEOUT '+label));
      },10000);
      ws.addEventListener('open',()=>finish(),{once:true});
      ws.addEventListener('error',()=>finish(Error('CDP_CONNECT_FAILED '+label)),{once:true});
      ws.addEventListener('close',()=>finish(Error('CDP_CONNECT_CLOSED '+label)),{once:true});
    });
    return new Cdp(ws);
  }
  call(method,params={}) {
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(id);
        reject(Error('CDP_CALL_TIMEOUT '+method+' id='+id));
      },15000);
      this.pending.set(id,{
        timer,
        resolve:value=>{clearTimeout(timer);resolve(value);},
        reject:error=>{clearTimeout(timer);reject(error);}
      });
      try{this.ws.send(JSON.stringify({id,method,params}));}
      catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }
  async eval(expression) {
    const response=await this.call('Runtime.evaluate',{
      expression,awaitPromise:true,returnByValue:true
    });
    if(response.exceptionDetails)throw Error(response.exceptionDetails.text||'CDP_EVALUATION_FAILED');
    return response.result?.value;
  }
  close(){
    for(const [id,pending] of this.pending){
      this.pending.delete(id);clearTimeout(pending.timer);
      pending.reject(Error('CDP_CLIENT_CLOSED'));
    }
    this.ws.close();
  }
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout,label){
  const end=Date.now()+timeout;
  let last='';
  while(Date.now()<end){
    const remaining=end-Date.now();
    let timer;
    try{
      const value=await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(Error('STEP_ATTEMPT_TIMEOUT')),Math.min(2000,remaining));
        })
      ]);
      if(value)return value;
    }catch(error){last=error?.message||String(error);}
    finally{clearTimeout(timer);}
    if(Date.now()<end)await sleep(50);
  }
  throw Error('R4_MUTATION_CANCEL_'+label+'_TIMEOUT '+last);
}
test('real MV3 cancels a document-bound operation before its side-effect boundary and refuses after it',{timeout:120000},async()=>{
  const browser=process.env.CHROME_BIN;
  assert.ok(browser&&fs.existsSync(browser),'CHROME_FOR_TESTING_REQUIRED');
  const xvfb=spawnSync('which',['xvfb-run'],{encoding:'utf8'});
  assert.equal(xvfb.status,0,'XVFB_REQUIRED');

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-r4-mutation-cancel-'));
  const ext=path.join(dir,'extension'),profile=path.join(dir,'profile');
  fs.mkdirSync(ext);fs.mkdirSync(profile);
  const sourcePath=new URL('../extension/page.js',import.meta.url);
  let pageSource=fs.readFileSync(sourcePath,'utf8');
  const marker='      await sleep(0);\n      checkOperationCancelled();';
  assert.equal(pageSource.split(marker).length-1,1,'OPERATION_START_CANCELLATION_MARKER_MISSING');
  // Test-only pause in this disposable extension copy, immediately before
  // the first cancellation checkpoint; production source is not changed.
  pageSource=pageSource.replace(marker,'      await sleep(450);\n      checkOperationCancelled();');
  fs.writeFileSync(path.join(ext,'page.js'),pageSource);
  fs.writeFileSync(path.join(ext,'background.js'),
    "import {pageAction} from './page.js';\nglobalThis.__r4PageAction=pageAction;\n");
  fs.writeFileSync(path.join(ext,'harness.html'),
    '<!doctype html><meta charset="utf-8"><title>R4 cancellation harness</title>'+
    '<script type="module" src="harness.js"></script>');
  fs.writeFileSync(path.join(ext,'harness.js'),
    "import {pageAction} from './page.js';\nglobalThis.__r4PageAction=pageAction;\n");
  const extensionId=[...crypto.createHash('sha256').update(path.resolve(ext)).digest('hex').slice(0,32)]
    .map(c=>'abcdefghijklmnop'[parseInt(c,16)]).join('');
  fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify({
    manifest_version:3,name:'R4 mutation cancellation fixture',version:'0.1.0',
    background:{service_worker:'background.js',type:'module'},
    permissions:['scripting','tabs'],
    host_permissions:['https://claude.ai/*']
  }));

  const key=path.join(dir,'key.pem'),crt=path.join(dir,'cert.pem');
  const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes',
    '-keyout',key,'-out',crt,'-days','1','-subj','/CN=claude.ai',
    '-addext','subjectAltName=DNS:claude.ai'],{encoding:'utf8'});
  assert.equal(cert.status,0,'TLS_FIXTURE_CERT_FAILED');
  const html='<!doctype html><meta charset="utf-8"><title>R4 mutation cancellation fixture</title>'+
    '<button id="r4Action" type="button">Confirm action</button>'+
    '<script>const b=document.querySelector("#r4Action");b.dataset.clickCount="0";'+
    'b.addEventListener("click",()=>{b.dataset.clickCount=String(Number(b.dataset.clickCount||"0")+1)});</script>';
  const tls=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(crt)},
    (req,res)=>{
      if(!/^\/chat\/[A-Za-z0-9_-]{8,128}$/.test(new URL(req.url,'https://claude.ai').pathname)){
        res.writeHead(404);res.end();return;
      }
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      res.end(html);
    });
  const proxy=net.createServer();
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
  let chrome=null,harness=null,browserCdp=null;
  let diagnosticPhase='setup';
  const diagnosticKeepAlive=setTimeout(()=>console.error('[R4 MUTATION CANCEL DIAGNOSTIC] stalled phase='+diagnosticPhase),5000);
  try{
    await new Promise((resolve,reject)=>{tls.once('error',reject);tls.listen(8443,'127.0.0.1',resolve);});
    await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
    const proxyPort=proxy.address().port;
    chrome=spawn(xvfb.stdout.trim(),['-a',browser,'--no-sandbox','--disable-gpu',
      '--disable-dev-shm-usage','--no-first-run','--no-default-browser-check',
      '--disable-background-networking','--ignore-certificate-errors',
      '--proxy-server=http://127.0.0.1:'+proxyPort,'--remote-allow-origins=*',
      '--user-data-dir='+profile,'--load-extension='+ext,
      '--disable-extensions-except='+ext,'--remote-debugging-port=0','about:blank'],
      {stdio:'ignore',detached:true});
    const debugPort=await until(()=>{
      const file=path.join(profile,'DevToolsActivePort');
      return fs.existsSync(file)?Number(fs.readFileSync(file,'utf8').split(/\r?\n/)[0]):0;
    },15000,'DEBUG_PORT');
    console.log('[R4 MUTATION CANCEL STEP] DevTools endpoint file found on port '+debugPort);
    const versionResponse=await fetch('http://127.0.0.1:'+debugPort+'/json/version');
    assert.equal(versionResponse.ok,true,'CDP_VERSION_ENDPOINT_FAILED');
    const version=await versionResponse.json();
    assert.ok(version.webSocketDebuggerUrl,'CDP_BROWSER_WEBSOCKET_MISSING');
    browserCdp=await Cdp.connect(version.webSocketDebuggerUrl,'browser');
    const harnessUrl='chrome-extension://'+extensionId+'/harness.html';
    const created=await browserCdp.call('Target.createTarget',{url:harnessUrl});
    assert.ok(created?.targetId,'EXTENSION_HARNESS_TARGET_CREATE_FAILED');
    console.log('[R4 MUTATION CANCEL STEP] created disposable extension harness page');
    const targets=async()=>{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),2500);
      try{
        const response=await fetch('http://127.0.0.1:'+debugPort+'/json/list',{signal:controller.signal});
        if(!response.ok)throw Error('CDP_TARGETS_HTTP_'+response.status);
        return await response.json();
      }finally{clearTimeout(timer);}
    };
    const harnessTarget=await until(async()=>(await targets()).find(t=>
      t.type==='page'&&t.url==='chrome-extension://'+extensionId+'/harness.html'&&t.webSocketDebuggerUrl),
      15000,'EXTENSION_HARNESS_PAGE');
    console.log('[R4 MUTATION CANCEL STEP] disposable extension harness page found');
    harness=await Cdp.connect(harnessTarget.webSocketDebuggerUrl,'extension-harness');
    await harness.call('Runtime.enable');
    await until(()=>harness.eval('typeof globalThis.__r4PageAction==="function"'),10000,'PAGE_ACTION_EXPORT');
    // Use the callback form for scripting.executeScript in this MV3 fixture.
    // Chrome 158 can leave the Promise form pending from an extension page;
    // callback completion gives the test a deterministic API receipt.
    await harness.eval('globalThis.__r4ExecuteDiagnostics={calls:0,callbacks:0,lastError:null,lastTarget:null};'+
      'globalThis.__r4Execute=details=>new Promise((resolve,reject)=>{'+
      'globalThis.__r4ExecuteDiagnostics.calls++;'+
      'globalThis.__r4ExecuteDiagnostics.lastTarget=details.target;'+
      'chrome.scripting.executeScript(details,results=>{'+
      'globalThis.__r4ExecuteDiagnostics.callbacks++;'+
      'const error=chrome.runtime.lastError;'+
      'globalThis.__r4ExecuteDiagnostics.lastError=error?.message||null;'+
      'if(error)reject(Error(error.message));else resolve(results);});});true');
    console.log('[R4 MUTATION CANCEL STEP] extension harness ready');

    // Create the provider tab through the browser-level CDP session rather
    // than awaiting chrome.tabs.create() from an extension page. The latter
    // can leave Runtime.evaluate awaiting a Chrome API promise that never
    // settles in this disposable MV3 harness. Resolve the tab by exact URL
    // using the callback form of tabs.query, then probe its document.
    const providerUrl='https://claude.ai/chat/r4mutationcancel01';
    diagnosticPhase='provider Target.createTarget';
    console.log('[R4 MUTATION CANCEL STEP] creating provider target');
    // Create the provider target through browser CDP, then resolve its
    // Chrome tab ID through the extension API callback. Do not wait for
    // tabs.onCreated in an extension document: Chrome may deliver that event
    // only to the extension service worker in this disposable MV3 setup.
    const providerTarget=await browserCdp.call('Target.createTarget',{url:providerUrl});
    assert.ok(providerTarget?.targetId,'PROVIDER_TARGET_CREATE_FAILED');
    diagnosticPhase='provider tabs.query dispatch';
    console.log('[R4 MUTATION CANCEL STEP] provider target created; querying tabs');
    await harness.eval('globalThis.__r4ProviderTab=null;chrome.tabs.query({},tabs=>{'+
      'if(chrome.runtime.lastError)return;'+
      'globalThis.__r4ProviderTab=tabs.find(t=>t.url==='+JSON.stringify(providerUrl)+
      '||t.pendingUrl==='+JSON.stringify(providerUrl)+')||null;});true');
    diagnosticPhase='provider tabs.query receipt';
    const tab=await until(()=>harness.eval('globalThis.__r4ProviderTab'),10000,'PROVIDER_TAB_QUERY');
    assert.ok(Number.isSafeInteger(tab?.id),'PROVIDER_TAB_CREATE_FAILED');
    const tabId=tab.id;
    console.log('[R4 MUTATION CANCEL STEP] provider fixture tab created id='+tabId);
    diagnosticPhase='provider page readiness and documentId probe';
    console.log('[R4 MUTATION CANCEL STEP] probing provider documentId');
    const pageInfo=await until(()=>harness.eval('(async()=>new Promise(resolve=>chrome.tabs.get('+tabId+',t=>{'+
      'if(chrome.runtime.lastError||t?.status!=="complete"){resolve(null);return;}'+
      'chrome.scripting.executeScript({target:{tabId:'+tabId+'},func:()=>({origin:location.origin,ready:document.readyState,'+
      'clicks:document.querySelector("#r4Action")?.dataset.clickCount})},r=>{'+
      'if(chrome.runtime.lastError||!r?.[0]?.documentId){resolve(null);return;}'+
      'resolve({documentId:r[0].documentId,result:r[0].result});});}))())'),
      20000,'PROVIDER_PAGE_READY');
    console.log('[R4 MUTATION CANCEL STEP] provider fixture page ready');
    diagnosticPhase='mutation operation assertions';
    assert.equal(pageInfo.result.origin,'https://claude.ai');
    const documentId=pageInfo.documentId;
    const target={tabId,documentIds:[documentId]};
    const origin='https://claude.ai';
    const invoke=(name,args)=>Promise.race([harness.eval('(async()=>{const out=await globalThis.__r4Execute({'+
      'target:'+JSON.stringify(target)+',world:"ISOLATED",func:globalThis.__r4PageAction,'+
      'args:'+JSON.stringify([name,args,origin])+'});return out[0]})()'),sleep(6000).then(async()=>{const diagnostics=await harness.eval('JSON.stringify(globalThis.__r4ExecuteDiagnostics||null)').catch(e=>String(e.message));throw Error('R4_EXECUTE_SCRIPT_CALLBACK_DIAGNOSTIC '+diagnostics);})]);
    const inspect=()=>harness.eval('(async()=>{const out=await globalThis.__r4Execute({'+
      'target:'+JSON.stringify(target)+',world:"ISOLATED",func:id=>({state:globalThis.__chromeBridgeOperationRegistry?.[id]?.state,'+
      'sideEffectStarted:globalThis.__chromeBridgeOperationRegistry?.[id]?.sideEffectStarted===true}),'+
      'args:["operation_cancel_safe_0001"]});return out[0]?.result})()');

    const preemptedId='operation_cancel_preempted_0001';
    // Revoke wins before the original page action has registered. The
    // tombstone must reject the later injection for this exact operation ID.
    const preemptiveCancel=await invoke('cancel_operation',{operationId:preemptedId,timeoutMs:2000});
    assert.equal(preemptiveCancel.result.operationId,preemptedId);
    assert.equal(preemptiveCancel.result.preemptedBeforeStart,true);
    assert.equal(preemptiveCancel.result.safeToRelease,true);
    assert.equal(preemptiveCancel.result.sideEffectStarted,false);
    const preemptedMutation=await invoke('browser_click',{
      operationId:preemptedId,selector:'#r4Action',controlExpires:Date.now()+120000
    });
    assert.equal(preemptedMutation.result.error,'MUTATION_CANCELLED_BEFORE_SIDE_EFFECT');
    assert.equal(preemptedMutation.result.dispatchState,'NOT_PERFORMED');
    assert.equal(preemptedMutation.result.sideEffect,'none');
    const preemptedClickCount=await harness.eval('(async()=>{const out=await globalThis.__r4Execute({'+
      'target:'+JSON.stringify(target)+',func:()=>document.querySelector("#r4Action").dataset.clickCount});return out[0].result})()');
    assert.equal(preemptedClickCount,'0','a pre-injection Revoke tombstone must block a late page action');
    console.log('[R4 MUTATION CANCEL STEP] pre-injection tombstone passed');

    const safeId='operation_cancel_safe_0001';
    const safeMutation=invoke('browser_click',{
      operationId:safeId,selector:'#r4Action',controlExpires:Date.now()+120000
    });
    await until(async()=> (await inspect())?.state==='RUNNING',5000,'SAFE_OPERATION_REGISTERED');
    console.log('[R4 MUTATION CANCEL STEP] operation registered before side effect');
    const cancel=await invoke('cancel_operation',{operationId:safeId,timeoutMs:2000});
    const cancelledMutation=await safeMutation;
    console.log('[R4 MUTATION CANCEL STEP] cooperative cancellation receipt received');
    assert.equal(cancel.result.operationId,safeId);
    assert.equal(cancel.result.safeToRelease,true);
    assert.equal(cancel.result.state,'CANCELLED_BEFORE_SIDE_EFFECT');
    assert.equal(cancel.result.sideEffectStarted,false);
    assert.equal(cancelledMutation.documentId,documentId);
    assert.equal(cancelledMutation.result.error,'MUTATION_CANCELLED_BEFORE_SIDE_EFFECT');
    assert.equal(cancelledMutation.result.dispatchState,'NOT_PERFORMED');
    assert.equal(cancelledMutation.result.sideEffect,'none');
    const repeatedCancel=await invoke('cancel_operation',{operationId:safeId,timeoutMs:500});
    assert.equal(repeatedCancel.result.operationId,safeId);
    assert.equal(repeatedCancel.result.safeToRelease,true,'a repeat Revoke must receive the same safe terminal proof');
    assert.equal(repeatedCancel.result.state,'CANCELLED_BEFORE_SIDE_EFFECT');
    const afterCancel=await harness.eval('(async()=>{const out=await globalThis.__r4Execute({'+
      'target:'+JSON.stringify(target)+',func:()=>document.querySelector("#r4Action").dataset.clickCount});return out[0].result})()');
    assert.equal(afterCancel,'0','a cancelled pre-boundary operation must not click');

    const committedId='operation_cancel_effect_0002';
    const committed=await invoke('browser_click',{
      operationId:committedId,selector:'#r4Action',controlExpires:Date.now()+120000
    });
    assert.equal(committed.result.clicked,true);
    const lateCancel=await invoke('cancel_operation',{operationId:committedId,timeoutMs:500});
    assert.equal(lateCancel.result.operationId,committedId);
    assert.equal(lateCancel.result.found,true);
    assert.equal(lateCancel.result.safeToRelease,false);
    assert.equal(lateCancel.result.sideEffectStarted,true);
    assert.equal(lateCancel.result.state,'SIDE_EFFECT_STARTED');
    const replayedMutation=await invoke('browser_click',{
      operationId:committedId,selector:'#r4Action',controlExpires:Date.now()+120000
    });
    assert.equal(replayedMutation.result.error,'MUTATION_OPERATION_ALREADY_SEEN');
    const clickCount=await harness.eval('(async()=>{const out=await globalThis.__r4Execute({'+
      'target:'+JSON.stringify(target)+',func:()=>document.querySelector("#r4Action").dataset.clickCount});return out[0].result})()');
    assert.equal(clickCount,'1','a late cancellation must not misclassify a fired click as NOT_PERFORMED');
    console.log('[R4 MUTATION CANCEL STEP] post-boundary cancellation refused');
    console.log('[R4 MUTATION CANCEL REAL] exact-document cancellation before boundary PASS; after-boundary cancellation refused');
  }finally{
    clearTimeout(diagnosticKeepAlive);
    harness?.close();
    browserCdp?.close();
    if(chrome&&!chrome.killed){try{process.kill(-chrome.pid,'SIGTERM');}catch{chrome.kill('SIGTERM');}}
    if(tls.listening)await new Promise(resolve=>tls.close(resolve));
    if(proxy.listening)await new Promise(resolve=>proxy.close(resolve));
    try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:150});}
    catch(error){console.warn('[R4 MUTATION CANCEL] disposable profile cleanup deferred:',error.code);}
  }
});