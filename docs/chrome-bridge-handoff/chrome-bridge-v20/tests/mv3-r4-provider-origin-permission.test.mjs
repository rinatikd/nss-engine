import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const browser=process.env.CHROME_BIN;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,timeout,label)=>{
  const end=Date.now()+timeout;
  while(Date.now()<end){
    try{const value=await fn();if(value)return value;}catch{}
    await sleep(100);
  }
  throw Error('R4_PROVIDER_ORIGIN_'+label+'_TIMEOUT');
};
async function debugPort(profile){
  const file=path.join(profile,'DevToolsActivePort');
  return until(()=>fs.existsSync(file)?Number(fs.readFileSync(file,'utf8').split(/\r?\n/)[0]):0,12000,'DEBUG_PORT');
}
async function targets(port){
  return (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
}
class Cdp{
  constructor(ws){
    this.ws=ws;this.seq=0;this.pending=new Map();
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
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      this.ws.send(JSON.stringify({id,method,params}));
    });
  }
  async eval(expression){
    const result=await this.call('Runtime.evaluate',{
      expression,awaitPromise:true,returnByValue:true
    });
    if(result.exceptionDetails)throw Error(result.exceptionDetails.text||'CDP_EVALUATION_FAILED');
    return result.result?.value;
  }
  close(){this.ws.close();}
}

test('R4 disposable Chrome accepts the exact Claude origin and grants/revokes only its tab', {timeout:60000},async()=>{
  if(!browser||!fs.existsSync(browser))throw Error('CHROME_FOR_TESTING_REQUIRED');
  const display=spawnSync('which',['xvfb-run'],{encoding:'utf8'});
  if(display.status!==0)throw Error('XVFB_REQUIRED');

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-r4-origin-'));
  const extension=path.join(dir,'extension');
  const profile=path.join(dir,'profile');
  fs.mkdirSync(extension);fs.mkdirSync(profile);
  fs.mkdirSync(path.join(profile,'Default'),{recursive:true});
  fs.writeFileSync(path.join(profile,'Default','Preferences'),
    JSON.stringify({extensions:{ui:{developer_mode:true}}}));
  const modules=[
    'read-only-dispatch.js','background-control-grants.js',
    'permissions.js','page.js','secrets.js','adapters.js'
  ];
  for(const name of modules){
    fs.copyFileSync(path.join(root,'extension',name),path.join(extension,name));
  }
  fs.writeFileSync(path.join(extension,'background.js'),`// Test-only worker: statically import the production modules unchanged.
import {permittedTab} from './read-only-dispatch.js';
import {BackgroundControlGrants} from './background-control-grants.js';
globalThis.__r4PermissionGate={permittedTab,BackgroundControlGrants};
`);
  fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify({
    manifest_version:3,
    name:'R4 provider origin permission gate',
    version:'0.2.0',
    background:{service_worker:'background.js',type:'module'},
    permissions:['storage','scripting','tabs'],
    host_permissions:['https://claude.ai/*']
  }));

  let chromeProc,workerCdp;
  try{
    chromeProc=spawn(display.stdout.trim(),[
      '-a',browser,'--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
      '--no-first-run','--no-default-browser-check','--disable-background-networking',
      '--host-resolver-rules=MAP claude.ai 127.0.0.1',
      '--remote-allow-origins=*','--user-data-dir='+profile,
      '--load-extension='+extension,'--disable-extensions-except='+extension,
      '--remote-debugging-port=0','about:blank'
    ],{stdio:'ignore',detached:true});

    const port=await debugPort(profile);
    const worker=await until(async()=>{
      const list=await targets(port);
      return list.find(target=>target.type==='service_worker'&&
        /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(target.url)&&target.webSocketDebuggerUrl);
    },12000,'SERVICE_WORKER');
    workerCdp=await Cdp.connect(worker.webSocketDebuggerUrl);
    await workerCdp.call('Runtime.enable');
    await until(()=>workerCdp.eval('typeof chrome!=="undefined" && !!chrome.storage?.local && !!chrome.runtime?.id'),8000,'WORKER_CONTEXT');
    const apiDiagnostic=await workerCdp.eval(`JSON.stringify({
      runtime:typeof chrome.runtime?.id,
      storageLocal:!!chrome.storage?.local,
      storageSession:!!chrome.storage?.session,
      tabsCreate:typeof chrome.tabs?.create,
      permissionsContains:typeof chrome.permissions?.contains,
      scripting:typeof chrome.scripting?.executeScript
    })`);
    console.log('[R4 WORKER API]',apiDiagnostic);
    const api=JSON.parse(apiDiagnostic);
    assert.equal(api.storageSession,true,'Chrome storage.session must be available to the real Grant store');
    assert.equal(api.tabsCreate,'function','Chrome tabs.create must be available to the disposable worker');
    assert.equal(api.permissionsContains,'function','Chrome permissions.contains must be available');
    assert.equal(api.scripting,'function','Chrome scripting.executeScript must be available');

    const result=await workerCdp.eval(`(async()=>{
      const {permittedTab,BackgroundControlGrants}=globalThis.__r4PermissionGate||{};
      if(typeof permittedTab!=='function'||typeof BackgroundControlGrants!=='function')
        throw Error('R4_PERMISSION_GATE_MODULES_NOT_READY');
      const url='https://claude.ai/chat/r4fixture0001';
      const tabA=await chrome.tabs.create({url,active:false});
      const tabB=await chrome.tabs.create({url:'https://claude.ai/chat/r4fixture0002',active:false});
      await new Promise(resolve=>setTimeout(resolve,250));
      const current=await chrome.tabs.get(tabA.id);
      await chrome.storage.local.set({sites:{
        'https://claude.ai':{mode:'chat',adapter:'claude'}
      }});
      const hostPermission=await chrome.permissions.contains({origins:['https://claude.ai/*']});
      const permitted=await permittedTab(chrome,tabA.id);
      const grants=new BackgroundControlGrants(chrome);
      const grantA=await grants.grant({tabId:tabA.id,durationMinutes:15,localGesture:true});
      const grantB=await grants.grant({tabId:tabB.id,durationMinutes:15,localGesture:true});
      const active=await grants.activeGrants();
      await grants.revoke(tabA.id);
      const afterRevoke=await grants.activeGrants();
      await chrome.tabs.remove(tabA.id);
      await chrome.tabs.remove(tabB.id);
      return {
        url:current.url,origin:permitted.origin,adapter:permitted.site.adapter,
        hostPermission,grantTabId:grantA.tabId,otherGrantTabId:grantB.tabId,
        activeGrantCount:active.length,afterRevokeCount:afterRevoke.length,
        remainingTabId:afterRevoke[0]?.tabId
      };
    })()`);

    assert.equal(result.url,'https://claude.ai/chat/r4fixture0001','tab must retain the exact provider HTTPS origin');
    assert.equal(result.origin,'https://claude.ai');
    assert.equal(result.adapter,'claude');
    assert.equal(result.hostPermission,true,'manifest host permission must cover the exact provider origin');
    assert.ok(Number.isSafeInteger(result.grantTabId)&&result.grantTabId>0);
    assert.ok(Number.isSafeInteger(result.otherGrantTabId)&&result.otherGrantTabId>0);
    assert.notEqual(result.grantTabId,result.otherGrantTabId);
    assert.equal(result.activeGrantCount,2,'both real per-tab Grants must be effective before Revoke');
    assert.equal(result.afterRevokeCount,1,'Revoke of tab A must preserve tab B Grant');
    assert.equal(result.remainingTabId,result.otherGrantTabId,'the remaining effective Grant must belong to tab B');
    console.log('[R4 ORIGIN GATE] exact provider origin, permittedTab, session grant and revoke passed');
  }finally{
    workerCdp?.close();
    if(chromeProc&&!chromeProc.killed){
      try{process.kill(-chromeProc.pid,'SIGTERM');}catch{chromeProc.kill('SIGTERM');}
    }
    try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:200});}
    catch(error){console.warn('[R4 ORIGIN GATE] disposable profile cleanup deferred:',error.code);}
  }
});
