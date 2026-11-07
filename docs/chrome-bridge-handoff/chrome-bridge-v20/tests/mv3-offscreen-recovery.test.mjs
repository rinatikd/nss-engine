import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createBridge} from '../server/bridge.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,limit,label){
 const end=Date.now()+limit;
 let last;
 while(Date.now()<end){
  try{const v=await fn();if(v)return v;}catch(e){last=e.message;}
  await sleep(200);
 }
 throw Error('MV3_'+label+'_TIMEOUT '+(last||''));
}
class Cdp{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();
  ws.addEventListener('message',e=>{
   const m=JSON.parse(e.data),p=this.pending.get(m.id);if(!p)return;
   this.pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);
  });
 }
 static async connect(url){
  const ws=new WebSocket(url);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  return new Cdp(ws);
 }
 call(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){
  const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw Error(r.exceptionDetails.text);
  return r.result?.value;
 }
 close(){this.ws.close();}
}
test('actual MV3 offscreen reconnects through extension reload without control UI', {timeout:75000},async()=>{
 const chrome=process.env.CHROME_BIN;
 assert.ok(chrome&&fs.existsSync(chrome),'Chrome for Testing required');
 const xvfb=spawnSync('which',['xvfb-run'],{encoding:'utf8'});
 assert.equal(xvfb.status,0,'xvfb-run required');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-offscreen-e2e-'));
 const ext=path.join(dir,'ext'),profile=path.join(dir,'profile');
 fs.mkdirSync(ext);fs.mkdirSync(profile);
 for(const n of fs.readdirSync(new URL('../extension/',import.meta.url))){
  const src=new URL('../extension/'+n,import.meta.url);
  if(!/\.(js|html|css)$/.test(n)||!fs.statSync(src).isFile())continue;
  fs.writeFileSync(path.join(ext,n),fs.readFileSync(src,'utf8').replaceAll('http://127.0.0.1:17381','http://127.0.0.1:17481'));
 }
 fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify({
  manifest_version:3,name:'MV3 Offscreen Recovery Lab',version:'0.2.0',
  background:{service_worker:'background.js',type:'module'},
  permissions:['storage','scripting','activeTab','offscreen','alarms'],
  host_permissions:['http://127.0.0.1:17481/*'],
  action:{default_title:'Isolated MV3'}
 }));
 const browserToken=crypto.randomBytes(32).toString('hex');
 const agentToken=crypto.randomBytes(32).toString('hex');
 let proc=null,server=null,cdp=null;
 try{
  proc=spawn(xvfb.stdout.trim(),['-a',chrome,'--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
   '--disable-background-networking','--no-first-run','--remote-allow-origins=*',
   '--user-data-dir='+profile,'--load-extension='+ext,'--disable-extensions-except='+ext,
   '--remote-debugging-port=0','about:blank'],{stdio:'ignore',detached:true});
  const port=await until(()=>{
   const p=path.join(profile,'DevToolsActivePort');
   return fs.existsSync(p)?Number(fs.readFileSync(p,'utf8').split(/\r?\n/)[0]):0;
  },12000,'DEBUG_PORT');
  async function findWorker(){
   const list=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
   return list.find(t=>t.type==='service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url));
  }
  const initial=await until(findWorker,12000,'SERVICE_WORKER');
  const extensionId=initial.url.split('/')[2];
  const config={browserToken,agentToken,extensionId};
  const startServer=async()=>{
   const s=createBridge(config,{pollHold:350,timeout:4000});
   await new Promise(resolve=>s.listen(17481,'127.0.0.1',resolve));
   return s;
  };
  server=await startServer();
  async function status(){
   const res=await fetch('http://127.0.0.1:17481/mcp',{
    method:'POST',headers:{authorization:'Bearer '+agentToken,'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'browser_status',arguments:{}}})
   });
   assert.equal(res.status,200);
   const data=await res.json();return JSON.parse(data.result.content[0].text);
  }
  cdp=await Cdp.connect(initial.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  const settings={bridgeBackgroundMode:true,bridgeConnectionDesired:true,browserToken};
  const set=await cdp.eval('(async()=>{await chrome.storage.local.set('+JSON.stringify(settings)+');return true})()');
  assert.equal(set,true,'extension worker storage set');
  // A real extension restart makes background.js run maintainBackgroundIfEnabled.
  try{await cdp.eval('chrome.runtime.reload();true');}catch{}
  cdp.close();cdp=null;
  await until(async()=> (await status()).connected,16000,'RECONNECTED_AFTER_RELOAD');
  const resumed=await until(findWorker,10000,'RELOADED_WORKER');
  cdp=await Cdp.connect(resumed.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  const offscreen=await cdp.eval('(async()=>await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]}))()');
  assert.equal(offscreen.length,1,'exactly one real offscreen context');
  console.log('[MV3 REAL] extension reload restored background polling and one offscreen document');

  // Simulate real loopback server outage; same browser stays alive.
  await new Promise(resolve=>server.close(resolve));server=null;
  await sleep(1800);
  server=await startServer();
  await until(async()=> (await status()).connected,16000,'RECONNECTED_AFTER_SERVER_OUTAGE');
  console.log('[MV3 REAL] background polling recovered after server restart');

  // Persist manual disconnect and reload extension; must NOT auto-reconnect.
  const disabled=await cdp.eval('(async()=>{await chrome.storage.local.set({bridgeConnectionDesired:false,bridgeMutationLabMode:false});return true})()');
  assert.equal(disabled,true);
  try{await cdp.eval('chrome.runtime.reload();true');}catch{}
  cdp.close();cdp=null;
  await sleep(7500); // server considers a recently-seen browser connected for 6s
  assert.equal((await status()).connected,false,'manual disconnect survives extension reload');
  console.log('[MV3 REAL] manual disconnect persisted after extension reload');
 }finally{
  cdp?.close();
  if(proc){try{process.kill(-proc.pid,'SIGTERM');}catch{proc.kill('SIGTERM');}}
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
  catch(e){console.warn('[MV3 TEST] disposable profile cleanup deferred:',e.code);}
 }
});
