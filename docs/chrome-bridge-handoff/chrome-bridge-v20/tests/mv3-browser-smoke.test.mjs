import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const source=path.join(root,'extension');
const paths=[
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];
const chrome=paths.find(p=>p&&fs.existsSync(p));
if(!chrome)throw Error('REAL_MV3_CHROME_BINARY_UNAVAILABLE');
const xvfb=spawnSync('which',['xvfb-run'],{encoding:'utf8'});
if(xvfb.status!==0)throw Error('REAL_MV3_DISPLAY_UNAVAILABLE: xvfb-run missing');

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms,label) {
  const end=Date.now()+ms;
  while(Date.now()<end){const result=await check();if(result)return result;await sleep(200);}
  throw Error('MV3_TIMEOUT_'+label);
}
async function targetList(port) {
  try{
    const response=await fetch('http://127.0.0.1:'+port+'/json/list');
    if(!response.ok)return [];
    return await response.json();
  }catch{return [];}
}
test('real browser loads unpacked RC1 MV3 service worker in isolated profile', {timeout:45000},async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-mv3-real-'));
  const ext=path.join(temp,'extension'),profile=path.join(temp,'profile');
  fs.mkdirSync(ext);fs.mkdirSync(profile);
  // Only audited repo sources, never the user's installed extension.
  for(const name of fs.readdirSync(source)){
    if(!/\.(js|html|css)$/.test(name))continue;
    const file=path.join(source,name);
    if(!fs.statSync(file).isFile())continue;
    const original=fs.readFileSync(file,'utf8');
    fs.writeFileSync(path.join(ext,name),original.replaceAll('http://127.0.0.1:17381','http://127.0.0.1:17481'));
  }
  const manifest={
    manifest_version:3,name:'RC1 MV3 Disposable Acceptance',version:'0.2.0',
    background:{service_worker:'background.js',type:'module'},
    permissions:['storage','scripting','activeTab','offscreen','alarms'],
    host_permissions:['http://127.0.0.1:17481/*'],
    action:{default_title:'MV3 lab'},
  };
  fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify(manifest));
  for(const f of fs.readdirSync(ext)){
    if(f.endsWith('.js'))
      assert.ok(!fs.readFileSync(path.join(ext,f),'utf8').includes('http://127.0.0.1:17381'),
        'production endpoint leaked into '+f);
  }
  let proc=null, stderr='';
  try{
    proc=spawn(xvfb.stdout.trim(),['-a',chrome,
      '--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
      '--no-first-run','--no-default-browser-check','--remote-allow-origins=*',
      '--disable-background-networking','--user-data-dir='+profile,
      '--disable-extensions-except='+ext,'--load-extension='+ext,
      '--remote-debugging-port=0','about:blank'
    ],{stdio:['ignore','ignore','pipe'],detached:true});
    proc.stderr.on('data',chunk=>{stderr+=chunk.toString();if(stderr.length>50000)stderr=stderr.slice(-50000);});
    const portFile=path.join(profile,'DevToolsActivePort');
    const port=await until(async()=>{
      if(proc.exitCode!==null)throw Error('MV3_BROWSER_EXIT_'+proc.exitCode);
      if(!fs.existsSync(portFile))return null;
      const value=Number(fs.readFileSync(portFile,'utf8').split(/\r?\n/)[0]);
      return Number.isSafeInteger(value)&&value>0?value:null;
    },15000,'DEBUG_PORT');
    let lastTargets=[];
    let worker;
    try {
      worker=await until(async()=>{
        const tabs=await targetList(port);
        lastTargets=tabs.map(t=>({type:t.type,url:String(t.url).slice(0,150)}));
        return tabs.find(t=>t.type==='service_worker' &&
          /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url));
      },15000,'EXTENSION_SERVICE_WORKER');
    } catch(error) {
      console.error('[MV3 DIAGNOSTICS] browser:',chrome);
      console.error('[MV3 DIAGNOSTICS] version:',
        spawnSync(chrome,['--version'],{encoding:'utf8'}).stdout.trim());
      console.error('[MV3 DIAGNOSTICS] targets:',JSON.stringify(lastTargets));
      const preferences=path.join(profile,'Default','Preferences');
      if(fs.existsSync(preferences)){
        const data=JSON.parse(fs.readFileSync(preferences,'utf8'));
        console.error('[MV3 DIAGNOSTICS] extension ids:',
          JSON.stringify(Object.keys(data.extensions?.settings||{})));
      }
      console.error('[MV3 DIAGNOSTICS] extension errors:',
        stderr.split('\n').filter(line=>/extension|service.worker|manifest/i.test(line)).slice(-12).join('\n').slice(0,2000));
      throw error;
    }
    assert.ok(worker.webSocketDebuggerUrl,'real extension service worker has CDP target');
    assert.match(worker.url,/chrome-extension:\/\/[a-p]{32}\/background\.js/);
    console.log('[MV3 REAL] service worker discovered: extension loaded, type='+worker.type);
    // Do not treat this as approval of offscreen/recovery/Control/Windows E2E.
  }finally{
    if(proc&&!proc.killed){
      try { process.kill(-proc.pid,'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      await Promise.race([
        new Promise(resolve=>proc.once('close',resolve)),
        sleep(2500).then(()=>{if(proc.exitCode===null)proc.kill('SIGKILL');})
      ]);
    }
    fs.rmSync(temp,{recursive:true,force:true,maxRetries:12,retryDelay:200});
  }
});
