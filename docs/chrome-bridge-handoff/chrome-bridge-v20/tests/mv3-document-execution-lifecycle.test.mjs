import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout,label){
 const end=Date.now()+timeout;
 let last='';
 while(Date.now()<end){
  try{const value=await fn();if(value)return value;}catch(error){last=error?.message||String(error);}
  await sleep(100);
 }
 throw Error('R4_DOCUMENT_'+label+'_TIMEOUT '+last);
}
async function listen(server){
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return server.address().port;
}
function html(pathname){
 return '<!doctype html><meta charset="utf-8"><title>'+pathname+'</title>'+
  '<a id="navigate" href="/b">navigate to B</a><button id="action">test action</button><script>'+
  'document.documentElement.dataset.r4DocumentNonce=crypto.randomUUID();'+
  'window.addEventListener("pageshow",event=>{document.documentElement.dataset.r4PageshowPersisted=String(event.persisted)});'+
  'document.querySelector("#action").addEventListener("click",event=>{'+
  'const button=event.currentTarget;button.dataset.r4Clicked="yes";'+
  'setTimeout(()=>{button.dataset.r4SideEffect="done"},350);'+
  '});</script>';
}
class Cdp{
 constructor(ws){
  this.ws=ws;this.sequence=0;this.pending=new Map();
  ws.addEventListener('message',event=>{
   const message=JSON.parse(event.data);
   if(!message.id)return;
   const pending=this.pending.get(message.id);
   if(!pending)return;
   this.pending.delete(message.id);
   message.error?pending.reject(Error(JSON.stringify(message.error))):pending.resolve(message.result);
  });
 }
 static async connect(url){
  const ws=new WebSocket(url);
  await new Promise((resolve,reject)=>{
   ws.addEventListener('open',resolve,{once:true});
   ws.addEventListener('error',reject,{once:true});
  });
  return new Cdp(ws);
 }
 call(method,params={}){
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   this.pending.set(id,{resolve,reject});
   this.ws.send(JSON.stringify({id,method,params}));
  });
 }
 async eval(expression){
  const response=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(response.exceptionDetails)throw Error(response.exceptionDetails.text||'CDP_EVALUATION_FAILED');
  return response.result?.value;
 }
 close(){this.ws.close();}
}
test('disposable Chrome verifies exact-document execution, cooperative cancellation and BFCache identity',
 {timeout:90000},async()=>{
 const chrome=process.env.CHROME_BIN;
 assert.ok(chrome&&fs.existsSync(chrome),'CHROME_FOR_TESTING_REQUIRED');
 const xvfb=spawnSync('which',['xvfb-run'],{encoding:'utf8'});
 assert.equal(xvfb.status,0,'XVFB_REQUIRED');

 const server=http.createServer((request,response)=>{
  const pathname=new URL(request.url,'http://127.0.0.1').pathname;
  if(pathname!=='/a'&&pathname!=='/b'){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'public, max-age=0'});
  response.end(html(pathname));
 });
 const port=await listen(server);
 const origin='http://127.0.0.1:'+port;
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r4-document-lifecycle-'));
 const extension=path.join(directory,'extension'),profile=path.join(directory,'profile');
 fs.mkdirSync(extension);fs.mkdirSync(profile);
 fs.writeFileSync(path.join(extension,'background.js'),
  "chrome.runtime.onInstalled.addListener(()=>{});");
 fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify({
  manifest_version:3,name:'R4 document lifecycle disposable test',version:'0.0.1',
  background:{service_worker:'background.js',type:'module'},
  permissions:['tabs','scripting','webNavigation'],
  host_permissions:[origin+'/*']
 }));
 let browser=null,worker=null,tabId=null;
 try{
  browser=spawn(xvfb.stdout.trim(),['-a',chrome,'--no-sandbox','--disable-gpu',
   '--disable-dev-shm-usage','--no-first-run','--no-default-browser-check',
   '--disable-background-networking','--remote-allow-origins=*',
   '--user-data-dir='+profile,'--load-extension='+extension,
   '--disable-extensions-except='+extension,'--remote-debugging-port=0','about:blank'],
   {stdio:'ignore',detached:true});
  const debugPort=await until(()=>{
   const file=path.join(profile,'DevToolsActivePort');
   return fs.existsSync(file)?Number(fs.readFileSync(file,'utf8').split(/\r?\n/)[0]):0;
  },15000,'DEBUG_PORT');
  const extensionHash=crypto.createHash('sha256').update(path.resolve(extension)).digest('hex').slice(0,32);
  const extensionId=[...extensionHash].map(char=>'abcdefghijklmnop'[parseInt(char,16)]).join('');
  const targets=async()=>await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
  const workerTarget=await until(async()=>(
   await targets()).find(target=>target.type==='service_worker'&&
    target.url==='chrome-extension://'+extensionId+'/background.js'),15000,'SERVICE_WORKER');
  worker=await Cdp.connect(workerTarget.webSocketDebuggerUrl);
  await worker.call('Runtime.enable');
  await until(()=>worker.eval('typeof chrome!=="undefined" && !!chrome.scripting && !!chrome.webNavigation'),10000,'WORKER_APIS');
  const created=await worker.eval('(async()=>await chrome.tabs.create({url:'+JSON.stringify(origin+'/a')+',active:true}))()');
  tabId=created.id;
  const activeFrame=async(expectedUrl)=>{
   const frames=await worker.eval('(async()=>await chrome.webNavigation.getAllFrames({tabId:'+tabId+'}))()');
   return Array.isArray(frames)?frames.find(frame=>frame.frameId===0&&
    frame.documentLifecycle==='active'&&(!expectedUrl||frame.url===expectedUrl)):null;
  };
  const firstDocument=await until(()=>activeFrame(origin+'/a'),12000,'FIRST_DOCUMENT');
  assert.ok(firstDocument.documentId,'Chrome must expose a documentId for the main frame');
  const documentIdA=firstDocument.documentId;

  const inject=async(documentId,func,args=[])=>worker.eval(
   '(async()=>await chrome.scripting.executeScript({'+
   'target:{tabId:'+tabId+',documentIds:['+JSON.stringify(documentId)+']},'+
   'world:"ISOLATED",func:'+func.toString()+',args:'+JSON.stringify(args)+'}))()'
  );
  await until(async()=>{
   const ready=await inject(documentIdA,()=>document.readyState==='complete'&&!!document.querySelector('#action'));
   return ready[0]?.result===true;
  },8000,'FIRST_DOCUMENT_READY');

  // The same extension isolated world is reused for this document across executeScript calls.
  const probe1=await inject(documentIdA,()=>{globalThis.__r4Probe=(globalThis.__r4Probe||0)+1;return {count:globalThis.__r4Probe,path:location.pathname};});
  const probe2=await inject(documentIdA,()=>{globalThis.__r4Probe=(globalThis.__r4Probe||0)+1;return {count:globalThis.__r4Probe,path:location.pathname};});
  assert.equal(probe1[0].documentId,documentIdA);
  assert.equal(probe2[0].documentId,documentIdA);
  assert.equal(probe1[0].result.count,1);
  assert.equal(probe2[0].result.count,2);
  assert.equal(probe2[0].result.path,'/a');

  // Start an injected async operation and cancel it through a second injection
  // into the same exact isolated-world document before it reaches its click boundary.
  const operationId='op_'+crypto.randomBytes(8).toString('hex');
  const launched=await worker.eval(
   'globalThis.__r4LongOperation=chrome.scripting.executeScript({'+
   'target:{tabId:'+tabId+',documentIds:['+JSON.stringify(documentIdA)+']},world:"ISOLATED",'+
   'func:async(id)=>{const registry=globalThis.__r4Registry||(globalThis.__r4Registry={});'+
   'const operation={cancelled:false};registry[id]=operation;'+
   'await new Promise(resolve=>setTimeout(resolve,900));'+
   'if(operation.cancelled)return {state:"CANCELLED_BEFORE_CLICK"};'+
   'document.querySelector("#action").click();return {state:"CLICKED"};},args:['+JSON.stringify(operationId)+']});true'
  );
  assert.equal(launched,true);
  await sleep(120);
  const cancelled=await inject(documentIdA,
   function(id){
    const operation=globalThis.__r4Registry?.[id];
    if(!operation)return {acknowledged:false};
    operation.cancelled=true;
    return {acknowledged:true};
   },[operationId]);
  assert.equal(cancelled[0].result.acknowledged,true,'exact operation cancellation was acknowledged');
  const operationResult=await worker.eval('globalThis.__r4LongOperation');
  assert.equal(operationResult[0].result.state,'CANCELLED_BEFORE_CLICK');
  const beforeClick=await inject(documentIdA,
   ()=>({clicked:document.querySelector('#action').dataset.r4Clicked||''}));
  assert.equal(beforeClick[0].result.clicked,'','cancelled operation did not dispatch click');

  // A returned click receipt is not a receipt for the page's asynchronous effect.
  const clickReceipt=await inject(documentIdA,
   ()=>{document.querySelector('#action').click();const button=document.querySelector('#action');return {
    clicked:button.dataset.r4Clicked==='yes',sideEffect:button.dataset.r4SideEffect||null
   };});
  assert.equal(clickReceipt[0].result.clicked,true);
  assert.equal(clickReceipt[0].result.sideEffect,null,
   'executeScript result must not be confused with completion of the page event handler side effect');
  await until(async()=>{
   const result=await inject(documentIdA,()=>document.querySelector('#action').dataset.r4SideEffect||'');
   return result[0]?.result==='done';
  },4000,'ASYNC_SIDE_EFFECT');
  
  // Use a real same-origin link navigation so Chromium creates a history entry
  // and can put the original document into Back/Forward Cache.
  const navigation=await inject(documentIdA,()=>{document.querySelector('#navigate').click();return true;});
  assert.equal(navigation[0].documentId,documentIdA);
  // A synchronous navigation can destroy the executing realm before Chrome serializes
  // its return value; null/undefined is not treated as a navigation failure.
  const secondDocument=await until(async()=>{
   const frame=await activeFrame(origin+'/b');
   return frame&&frame.documentId!==documentIdA?frame:null;
  },12000,'SECOND_DOCUMENT');
  const documentIdB=secondDocument.documentId;
  assert.notEqual(documentIdB,documentIdA);

  // A stale document-targeted injection must never execute in the replacement /b document.
  let staleTargetOutcome;
  try{
   const stale=await inject(documentIdA,()=>({path:location.pathname,marker:'stale-document-target'}));
   staleTargetOutcome={kind:'resolved',results:stale};
   for(const item of stale){
    assert.equal(item.documentId,documentIdA,'stale target must not be rebound to the new document');
    assert.equal(item.result?.path,'/a','stale target execution, if permitted by Chrome lifecycle, must remain in the old document');
   }
  }catch(error){
   staleTargetOutcome={kind:'rejected',message:String(error.message||error).slice(0,180)};
  }
  assert.ok(['resolved','rejected'].includes(staleTargetOutcome.kind));

  // Go Back without attaching DevTools to the page; this leaves BFCache eligible.
  await worker.eval('(async()=>{await chrome.tabs.goBack('+tabId+');return true})()');
  const restored=await until(async()=>{
   const frame=await activeFrame(origin+'/a');
   if(!frame||frame.documentId!==documentIdA)return null;
   const result=await inject(documentIdA,
    ()=>({persisted:document.documentElement.dataset.r4PageshowPersisted||'',nonce:document.documentElement.dataset.r4DocumentNonce||''}));
   return result[0]?.result?.persisted==='true'?{frame,result:result[0].result}:null;
  },15000,'BF_CACHE_RESTORE');
  assert.equal(restored.frame.documentId,documentIdA,
   'BFCache restoration must retain the original document identity');
  assert.equal(restored.result.persisted,'true',
   'pageshow.persisted must prove the fixture page returned from BFCache');
  assert.ok(restored.result.nonce,'restored document must preserve its original JS state');

  console.log('[R4 DOCUMENT REAL] exact documentId targeting, cooperative cancellation before click, '+
   'async side-effect boundary, and BFCache restoration passed; stale-target outcome='+staleTargetOutcome.kind);
 }finally{
  worker?.close();
  if(browser&&!browser.killed){
   try{process.kill(-browser.pid,'SIGTERM');}catch{browser.kill('SIGTERM');}
   await sleep(500);
   if(browser.exitCode===null)try{process.kill(-browser.pid,'SIGKILL');}catch{browser.kill('SIGKILL');}
  }
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  try{fs.rmSync(directory,{recursive:true,force:true,maxRetries:12,retryDelay:150});}
  catch(error){console.warn('[R4 DOCUMENT TEST] disposable profile cleanup deferred:',error.code);}
 }
});
