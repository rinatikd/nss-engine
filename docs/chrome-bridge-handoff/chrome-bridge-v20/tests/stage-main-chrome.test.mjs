import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner=fileURLToPath(new URL('../scripts/stage-main-chrome.mjs', import.meta.url));
function fixture(port=17485) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-main-stage-'));
  const source=path.join(home,'extension'),output=path.join(home,'output');
  fs.mkdirSync(source);
  const files={
    'control.js':"const BRIDGE = 'http://127.0.0.1:17381';\n",
    'connection-check.js':"endpoint = 'http://127.0.0.1:17381/bridge/poll',\n",
    'transport-engine.js':"const DEFAULT_ENDPOINT = 'http://127.0.0.1:17381';\n",
    'secrets.js':"export const redact = x => x;\n",
    'background.js':"export const state = 'isolated';\n"
  };
  for(const [name,data] of Object.entries(files)) fs.writeFileSync(path.join(source,name),data);
  const manifest=path.join(home,'manifest.json');
  fs.writeFileSync(manifest,JSON.stringify({
    manifest_version:3,background:{service_worker:'background.js',type:'module'},
    host_permissions:['http://127.0.0.1:'+port+'/*'],
    optional_host_permissions:['https://claude.ai/*','https://grok.com/*']
  }));
  const run=(p=port)=>spawnSync(process.execPath,[runner,source,output,manifest,String(p)],{encoding:'utf8'});
  return {home,source,output,manifest,run};
}

test('isolated stage rewrites only explicit endpoints and preserves source', t => {
  const x=fixture();t.after(()=>fs.rmSync(x.home,{recursive:true,force:true}));
  const result=x.run();
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/STAGED_NOT_INSTALLED/);
  for(const name of ['control.js','connection-check.js','transport-engine.js']){
    assert.match(fs.readFileSync(path.join(x.output,name),'utf8'),/127.0.0.1:17485/);
    assert.match(fs.readFileSync(path.join(x.source,name),'utf8'),/127.0.0.1:17381/);
  }
  assert.ok(fs.existsSync(path.join(x.output,'secrets.js')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.output,'manifest.json'))).host_permissions,
    ['http://127.0.0.1:17485/*']);
});

test('reject reserved production port without creating output', t => {
  const x=fixture(17381);t.after(()=>fs.rmSync(x.home,{recursive:true,force:true}));
  assert.notEqual(x.run(17381).status,0);
  assert.equal(fs.existsSync(x.output),false);
});
test('refuse same output twice without destructive overwrite', t => {
  const x=fixture();t.after(()=>fs.rmSync(x.home,{recursive:true,force:true}));
  assert.equal(x.run().status,0);
  assert.notEqual(x.run().status,0);
});
test('refuse stale endpoint patterns instead of silently mixing profiles', t => {
  const x=fixture();t.after(()=>fs.rmSync(x.home,{recursive:true,force:true}));
  fs.writeFileSync(path.join(x.source,'control.js'),"const BRIDGE = 'http://127.0.0.1:9999';\n");
  assert.notEqual(x.run().status,0);
  assert.equal(fs.existsSync(x.output),false);
});
test('refuse extra broad manifest host access', t => {
  const x=fixture();t.after(()=>fs.rmSync(x.home,{recursive:true,force:true}));
  const m=JSON.parse(fs.readFileSync(x.manifest));
  m.optional_host_permissions.push('https://*/*');
  fs.writeFileSync(x.manifest,JSON.stringify(m));
  assert.notEqual(x.run().status,0);
  assert.equal(fs.existsSync(x.output),false);
});
test('refuse source/output overlap', t => {
  const x=fixture();t.after(()=>fs.rmSync(x.home,{recursive:true,force:true}));
  const result=spawnSync(process.execPath,[runner,x.source,path.join(x.source,'nested'),x.manifest,'17485'],{encoding:'utf8'});
  assert.notEqual(result.status,0);
});
