import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createBridge} from '../server/bridge.mjs';

const root=path.resolve(import.meta.dirname,'..');
const browser=process.env.CHROME_BIN;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,timeout,label)=>{
 const end=Date.now()+timeout, errors=[];
 while(Date.now()<end){
   try{const value=await fn();if(value)return value;}
   catch(e){errors.push(e.message);}
   await sleep(200);
 }
 throw Error('MV3_'+label+'_TIMEOUT '+errors.slice(-2).join(' '));
};
async function portOf(profile){
 const filename=path.join(profile,'DevToolsActivePort');
 return until(()=>fs.existsSync(filename) ? Number(fs.readFileSync(filename,'utf8').split(/\r?\n/)[0]) : 0,12000,'DEBUG_PORT');
}
async function targets(port){
 const response=await fetch('http://127.0.0.1:'+port+'/json/list');
 return response.json();
}
class Cdp{
 constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(!m.id)return;const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});}
 static async connect(url){
  const ws=new WebSocket(url);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  return new Cdp(ws);
 }
 call(method,params={}){
  const id=++this.seq;
  return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});
 }
 async eval(expression){
  const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw Error(r.exceptionDetails.text||'EVALUATION_FAILED');
  return r.result?.value;
 }
 close(){this.ws.close();}
}
test('MV3 offscreen stays connected with panel closed; stop revokes session', {timeout:90000},async()=>{
 if(!browser||!fs.existsSync(browser))throw Error('CHROME_FOR_TESTING_REQUIRED');
 const display=spawnSync('which',['xvfb-run'],{encoding:'utf8'});
 if(display.status!==0)throw Error('XVFB_REQUIRED');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-mv3-lifecycle-'));
 const ext=path.join(dir,'extension'),profile=path.join(dir,'profile');
 fs.mkdirSync(ext);fs.mkdirSync(profile);
 for(const name of fs.readdirSync(path.join(root,'extension'))){
  const src=path.join(root,'extension',name);
  if(!fs.statSync(src).isFile()||!/\.(js|css|html)$/.test(name))continue;
  fs.writeFileSync(path.join(ext,name),
   fs.readFileSync(src,'utf8').replaceAll('http://127.0.0.1:17381','http://127.0.0.1:17481'));
 }
 fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify({
  manifest_version:3,name:'MV3 lifecycle isolated test',version:'0.2.0',
  background:{service_worker:'background.js',type:'module'},
  permissions:['storage','scripting','activeTab','offscreen','alarms'],
  host_permissions:['http://127.0.0.1:17481/*'],
  action:{default_title:'MV3 isolated test'}
 }));
 let chromeProc,bridge,port,control=null,browserCdp=null;
 const browserToken=crypto.randomBytes(32).toString('hex');
 const agentToken=crypto.randomBytes(32).toString('hex');
 try{
  chromeProc=spawn(display.stdout.trim(),['-a',browser,'--no-sandbox','--disable-gpu',
    '--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-background-networking',
    '--remote-allow-origins=*','--user-data-dir='+profile,'--load-extension='+ext,
    '--disable-extensions-except='+ext,'--remote-debugging-port=0','about:blank'],{stdio:'ignore'});
  port=await portOf(profile);
  const worker=await until(async()=>{
   const list=await targets(port);
   return list.find(t=>t.type==='service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url));
  },12000,'SERVICE_WORKER');
  const extensionId=worker.url.split('/')[2];
  bridge=createBridge({browserToken,agentToken,extensionId},{pollHold:400,timeout:3000});
  await new Promise(resolve=>bridge.listen(17481,'127.0.0.1',resolve));
  const version=await (await fetch('http://127.0.0.1:'+port+'/json/version')).json();
  browserCdp=await Cdp.connect(version.webSocketDebuggerUrl);
  async function openPanel(){
   const created=await browserCdp.call('Target.createTarget',{url:'chrome-extension://'+extensionId+'/control.html'});
   const tab=await until(async()=>{
    const list=await targets(port);
    return list.find(t=>t.id===created.targetId && t.webSocketDebuggerUrl);
   },8000,'CONTROL_TAB');
   const c=await Cdp.connect(tab.webSocketDebuggerUrl);
   await c.call('Runtime.enable');
   await until(()=>c.eval('typeof chrome!=="undefined" && !!chrome.storage?.local && !!chrome.runtime?.id'),6000,'CONTROL_READY');
   return {id:created.targetId,cdp:c};
  }
  async function browserStatus(){
   const r=await fetch('http://127.0.0.1:17481/mcp',{
    method:'POST',headers:{Authorization:'Bearer '+agentToken,'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
      params:{name:'browser_status',arguments:{}}})
   });
   assert.equal(r.status,200);
   const obj=await r.json();
   assert.notEqual(obj.result?.isError,true,JSON.stringify(obj));
   return JSON.parse(obj.result.content[0].text);
  }
  control=await openPanel();
  const settings={bridgeBackgroundMode:true,bridgeConnectionDesired:true,browserToken};
  assert.equal(await control.cdp.eval('(async()=>{await chrome.storage.local.set('+JSON.stringify(settings)+');return true})()'),true);
  const started=await control.cdp.eval('(async()=>await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"start-background"}))()');
  assert.equal(started?.ok,true,'background should start: '+JSON.stringify(started));
  await until(async()=> (await browserStatus()).connected,10000,'SERVER_CONNECTED');
  const offscreen=await control.cdp.eval('(async()=>await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]}))()');
  assert.equal(offscreen.length,1,'exactly one offscreen document');
  console.log('[MV3 E2E] browser connected, one real offscreen document');

  // Close actual control page: worker/offscreen must retain the bridge connection.
  await browserCdp.call('Target.closeTarget',{targetId:control.id});
  control.cdp.close();control=null;
  await sleep(2200);
  assert.equal((await browserStatus()).connected,true,'connection survives closed panel');
  console.log('[MV3 E2E] background connection survived closed control panel');

  control=await openPanel();
  const status=await control.cdp.eval('(async()=>await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"status"}))()');
  assert.equal(status?.connected,true,'reopened control page observes connected coordinator');
  const stopped=await control.cdp.eval('(async()=>await chrome.runtime.sendMessage({target:"bridge-coordinator",type:"stop-background"}))()');
  assert.equal(stopped?.ok,true);
  await until(async()=>!(await browserStatus()).connected,5000,'STOPPED');
  const state=await control.cdp.eval('(async()=>await chrome.storage.local.get(["bridgeConnectionDesired","bridgeMutationLabMode"]))()');
  assert.equal(state.bridgeConnectionDesired,false);
  assert.equal(state.bridgeMutationLabMode,false);
  console.log('[MV3 E2E] manual stop persisted, background connection dropped');
 }finally{
  control?.cdp.close();browserCdp?.close();
  if(chromeProc&&!chromeProc.killed)chromeProc.kill('SIGTERM');
  if(bridge?.listening)await new Promise(resolve=>bridge.close(resolve));
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
