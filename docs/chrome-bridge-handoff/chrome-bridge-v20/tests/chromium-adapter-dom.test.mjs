import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const browserCandidates = process.platform === 'win32'
  ? [process.env.CHROME_BIN, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
  : [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome'];
const chromeBin = browserCandidates.find(p => p && fs.existsSync(p));
if (!chromeBin) throw Error('CHROMIUM_NOT_AVAILABLE: real browser prerequisite missing');

const app = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>
  <div class="send-button-container"></div>
  <script type="module">
    import {pageAction} from '/extension/page.js';
    import {DEFAULT_ADAPTERS} from '/extension/adapters.js';
    const result=document.createElement('pre');
    result.id='browser-test-result';
    const composer=document.querySelector('.ql-editor');
    const buttons=document.querySelector('.send-button-container');
    composer.addEventListener('input',()=>{
      buttons.replaceChildren();
      if(composer.textContent.trim()){
        const b=document.createElement('button');
        b.className='send-button';
        b.setAttribute('aria-label','Send');
        buttons.appendChild(b);
      }
    });
    try {
      const a=DEFAULT_ADAPTERS.gemini;
      const empty=await pageAction('agent_selftest',{adapter:a},location.origin);
      composer.textContent='Synthetic unsent draft';
      composer.dispatchEvent(new InputEvent('input',{bubbles:true}));
      const drafted=await pageAction('agent_selftest',{adapter:a},location.origin);
      const context=await pageAction('agent_context',{},location.origin);
      const mutation=await pageAction('agent_send',{
        adapter:a,operationId:'geminiSyntheticSend0001',text:'Should not send',
        expectedOrigin:location.origin,expectedConversationId:'syntheticConversation0001',
        controlExpires:Date.now()+10000
      },location.origin);
      const controlProbe=await pageAction('browser_click',{
        operationId:'geminiSyntheticControl0001',selector:'.send-button',
        controlExpires:Date.now()+10000
      },location.origin);
      const tests={
        emptyComposer:empty.composer.matched===1,
        noSendWhenEmpty:empty.send.matched===0,
        dynamicSendAfterInput:drafted.send.matched===1 && drafted.send.visible===1,
        exactlyOneButton:drafted.diagnostics.sendCandidates.sendClass.matched===1,
        unverifiedLocalConversation:context.verified===false,
        sendBlockedWithoutVerifiedConversation:/Conversation changed or has no verified provider identifier/.test(mutation.error||''),
        noControlOnSyntheticOrigin:/Control denied: local re-grant required/.test(controlProbe.error||''),
        draftUnchanged:composer.textContent==='Synthetic unsent draft'
      };
      result.textContent=JSON.stringify(tests);
      document.body.appendChild(result);
    }catch(e){result.textContent=JSON.stringify({exception:String(e)});document.body.appendChild(result);}
  </script>
</body></html>`;

function chromiumDump(url, profile) {
  return new Promise((resolve,reject)=>{
    const args=[
      '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
      '--disable-background-networking','--no-first-run','--no-default-browser-check',
      '--virtual-time-budget=2500','--user-data-dir='+profile,
      '--dump-dom',url
    ];
    const child=spawn(chromeBin,args,{stdio:['ignore','pipe','pipe']});
    let stdout='', stderr='';
    child.stdout.on('data',v=>{stdout+=v;if(stdout.length>2_000_000)child.kill();});
    child.stderr.on('data',v=>{stderr+=v;if(stderr.length>300_000)child.kill();});
    const timer=setTimeout(()=>{child.kill();reject(Error('CHROMIUM_TIMEOUT'));},45000);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0)return reject(Error('CHROMIUM_EXIT_'+code+' '+stderr.slice(-300)));
      resolve(stdout);
    });
  });
}
test('real Chromium executes PR #97 Gemini DOM adapter on disposable local fixture', {timeout:60000}, async()=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'chromebridge-chromium-profile-'));
  const server=http.createServer((req,res)=>{
    if(req.url==='/gemini') {
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      res.end(app);
    } else if(['/extension/page.js','/extension/adapters.js'].includes(req.url)) {
      res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});
      res.end(fs.readFileSync(path.join(root,req.url.slice(1))));
    } else {res.writeHead(404);res.end('Not found');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const html=await chromiumDump('http://127.0.0.1:'+server.address().port+'/gemini',profile);
    const text=html.match(/<pre id="browser-test-result">([^<]*)<\/pre>/)?.[1];
    assert.ok(text,'Browser did not render test result: '+html.slice(-600));
    const decoded=text.replaceAll('&quot;','"').replaceAll('&amp;','&');
    const results=JSON.parse(decoded);
    for(const [name,ok] of Object.entries(results)) assert.equal(ok,true,name+': '+JSON.stringify(results));
  } finally {
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(profile,{recursive:true,force:true});
  }
});
