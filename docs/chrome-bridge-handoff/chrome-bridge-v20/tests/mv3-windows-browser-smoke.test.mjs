import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,limit,label) {
 const end=Date.now()+limit;let last;
 while(Date.now()<end) {
  try {const r=await fn();if(r)return r;}catch(e){last=e.message;}
  await pause(200);
 }
 throw Error('WIN_MV3_'+label+'_TIMEOUT '+(last||''));
}
class Cdp{
 constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();
  ws.addEventListener('message',e=>{
   const data=JSON.parse(e.data),p=this.pending.get(data.id);
   if(!p)return;
   this.pending.delete(data.id);
   data.error?p.reject(Error(JSON.stringify(data.error))):p.resolve(data.result);
  });
 }
 static async connect(url){
  const ws=new WebSocket(url);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  return new Cdp(ws);
 }
 call(method,params={}){
  const id=++this.seq;
  return new Promise((resolve,reject)=>{
   this.pending.set(id,{resolve,reject});
   this.ws.send(JSON.stringify({id,method,params}));
  });
 }
 async eval(code){
  const r=await this.call('Runtime.evaluate',{expression:code,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw Error(r.exceptionDetails.text||'EVAL_FAILED');
  return r.result?.value;
 }
 close(){this.ws.close();}
}
test('native Windows Chrome for Testing loads exact lab MV3 worker and control page', {timeout:50000},async()=>{
 if(process.platform!=='win32')throw Error('WINDOWS_RUNNER_REQUIRED');
 const chrome=process.env.CHROME_BIN;
 assert.ok(chrome&&fs.existsSync(chrome),'Chrome for Testing binary required');
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-win-mv3-'));
 const ext=path.join(folder,'extension'),profile=path.join(folder,'profile');
 fs.mkdirSync(ext);fs.mkdirSync(profile);
 fs.mkdirSync(path.join(profile,'Default'),{recursive:true});
 fs.writeFileSync(path.join(profile,'Default','Preferences'),JSON.stringify({extensions:{ui:{developer_mode:true}}}));
 const src=new URL('../extension/',import.meta.url);
 for(const name of fs.readdirSync(src)) {
  const file=new URL('../extension/'+name,import.meta.url);
  if(!/\.(js|css|html)$/.test(name)||!fs.statSync(file).isFile())continue;
  fs.writeFileSync(path.join(ext,name),fs.readFileSync(file,'utf8').replaceAll('http://127.0.0.1:17381','http://127.0.0.1:17481'));
 }
 fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify({
  manifest_version:3,version:'0.2.0',name:'Chrome Bridge Windows MV3 isolated smoke',
  background:{service_worker:'background.js',type:'module'},
  permissions:['storage','scripting','activeTab','offscreen','alarms'],
  host_permissions:['http://127.0.0.1:17481/*'],
  action:{default_title:'Windows test'}
 }));
 const digest=crypto.createHash('sha256').update(path.resolve(ext)).digest('hex').slice(0,32);
 const id=[...digest].map(c=>'abcdefghijklmnop'[parseInt(c,16)]).join('');
 let child=null,worker=null,control=null;
 try{
  child=spawn(chrome,[
   '--headless=new','--no-first-run','--no-default-browser-check',
   '--disable-gpu','--disable-background-networking',
   '--remote-allow-origins=*','--user-data-dir='+profile,
   '--disable-extensions-except='+ext,'--load-extension='+ext,
   '--remote-debugging-port=0','about:blank'
  ],{stdio:'ignore',windowsHide:true});
  const port=await until(()=>{
   const file=path.join(profile,'DevToolsActivePort');
   if(!fs.existsSync(file))return 0;
   return Number(fs.readFileSync(file,'utf8').split(/\r?\n/)[0]);
  },15000,'DEBUG_PORT');
  const list=async()=>(await (await fetch('http://127.0.0.1:'+port+'/json/list')).json());
  let target;
  try {
   target=await until(async()=>(await list()).find(t=>t.type==='service_worker'&&t.url==='chrome-extension://'+id+'/background.js'),15000,'EXACT_WORKER');
  } catch(error) {
   const inventory=await list();
   console.error('[WIN MV3] expected extension ID',id);
   console.error('[WIN MV3] browser targets',JSON.stringify(inventory.map(t=>({type:t.type,url:t.url}))));
   const prefs=path.join(profile,'Default','Preferences');
   if(fs.existsSync(prefs)) {
    try {
     const data=JSON.parse(fs.readFileSync(prefs,'utf8'));
     console.error('[WIN MV3] registered extension IDs',
       JSON.stringify(Object.keys(data.extensions?.settings||{})));
    } catch(e) {console.error('[WIN MV3] prefs read error',e.message);}
   }
   throw error;
  }
  worker=await Cdp.connect(target.webSocketDebuggerUrl);
  await worker.call('Runtime.enable');
  await until(()=>worker.eval('typeof chrome!=="undefined" && !!chrome.runtime?.id && !!chrome.storage?.local'),7000,'WORKER_API');
  const created=await worker.eval('(async()=>{const t=await chrome.tabs.create({url:chrome.runtime.getURL("control.html"),active:true});return t.id})()');
  assert.equal(typeof created,'number');
  const panel=await until(async()=>(await list()).find(t=>t.type==='page'&&t.url==='chrome-extension://'+id+'/control.html'),10000,'CONTROL_PAGE');
  control=await Cdp.connect(panel.webSocketDebuggerUrl);
  await control.call('Runtime.enable');
  const loaded=await until(()=>control.eval('location.protocol==="chrome-extension:" && !!chrome.runtime?.id && !!chrome.storage?.local'),8000,'CONTROL_API');
  assert.equal(loaded,true);
  console.log('[WIN MV3 E2E] exact unpacked service worker and control page available');
 }finally{
  worker?.close();control?.close();
  if(child&&!child.killed)child.kill();
  await pause(1200);
  try{fs.rmSync(folder,{recursive:true,force:true,maxRetries:12,retryDelay:250});}
  catch(e){console.warn('[WIN MV3] disposable CI profile cleanup deferred:',e.code);}
 }
});
