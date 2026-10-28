import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-update-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const kit=path.join(dir,'kit'),source=path.join(dir,'source'),output=path.join(dir,'candidate');
 fs.mkdirSync(kit);fs.mkdirSync(source);fs.mkdirSync(path.join(kit,'overlay'));
 fs.copyFileSync(new URL('./apply-update.mjs',import.meta.url),path.join(kit,'apply-update.mjs'));
 fs.writeFileSync(path.join(source,'original.txt'),'original');
 fs.writeFileSync(path.join(source,'private-config.json'),'synthetic-local-private-state');
 fs.writeFileSync(path.join(kit,'overlay','original.txt'),'updated');
 fs.writeFileSync(path.join(kit,'update-manifest.json'),JSON.stringify({schemaVersion:1,version:'test',originalArchiveSha256:hash('archive'),originalFiles:{'original.txt':hash('original')},updatedFiles:{'original.txt':hash('updated')}}));
 const run=()=>spawnSync(process.execPath,[path.join(kit,'apply-update.mjs'),'--source',source,'--output',output],{encoding:'utf8'});
 return {dir,kit,source,output,run};
}
test('updater verifies separate output and leaves original/private files untouched',t=>{
 const f=fixture(t);const r=f.run();assert.equal(r.status,0,r.stderr);
 assert.equal(fs.readFileSync(path.join(f.output,'original.txt'),'utf8'),'updated');
 assert.equal(fs.readFileSync(path.join(f.source,'original.txt'),'utf8'),'original');
 assert.equal(fs.existsSync(path.join(f.output,'private-config.json')),false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.output,'CANDIDATE_READY.json'))).verified,true);
 assert.notEqual(f.run().status,0);
});
test('wrong baseline creates no output',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.source,'original.txt'),'changed');assert.notEqual(f.run().status,0);assert.equal(fs.existsSync(f.output),false)});
test('tampered overlay creates no output',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.kit,'overlay','original.txt'),'tampered');assert.notEqual(f.run().status,0);assert.equal(fs.existsSync(f.output),false)});
test('manifest traversal creates no output',t=>{const f=fixture(t);const p=path.join(f.kit,'update-manifest.json');const m=JSON.parse(fs.readFileSync(p));m.originalFiles={'../escape':hash('bad')};fs.writeFileSync(p,JSON.stringify(m));assert.notEqual(f.run().status,0);assert.equal(fs.existsSync(f.output),false)});
test('source symlink is refused before output',t=>{const f=fixture(t);fs.renameSync(path.join(f.source,'original.txt'),path.join(f.source,'target.txt'));fs.symlinkSync(path.join(f.source,'target.txt'),path.join(f.source,'original.txt'));assert.notEqual(f.run().status,0);assert.equal(fs.existsSync(f.output),false)});
