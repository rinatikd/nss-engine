import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = process.argv[2] || 'C:\\Engineering\\chrome-bridge';
const verify = process.argv.includes('--verify');
const target = path.join(root, 'extension', 'control.js');
const marker = 'chromeBridgeSessionGrantsV1';
const reps = JSON.parse(fs.readFileSync(new URL('./replacements.json', import.meta.url),'utf8'));
if (!fs.existsSync(target)) throw Error('CONTROL_JS_NOT_FOUND');
const existing = fs.readFileSync(target,'utf8');
if (existing.includes(marker)) { console.log('ALREADY_PATCHED_SESSION_CONTROL'); process.exit(0); }
let modified = existing;
for (const [before, after] of reps) {
  const parts = modified.split(before);
  if (parts.length !== 2) throw Error('SOURCE_MISMATCH: ' + before.slice(0,90));
  modified = parts.join(after);
}
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const oldHash = digest(existing);
console.log('SOURCE_SHA256: '+oldHash);
if (verify) { console.log('READY_SESSION_CONTROL: no changes'); process.exit(0); }
if(digest(fs.readFileSync(target))!==oldHash) throw Error('SOURCE_CHANGED_AFTER_READ');
const backup = target+'.backup-session-control-'+new Date().toISOString().replace(/[:.]/g,'-');
fs.copyFileSync(target,backup,fs.constants.COPYFILE_EXCL);
try {
  fs.writeFileSync(target,modified,'utf8');
  execFileSync(process.execPath,['--check',target],{stdio:'pipe'});
  console.log('PATCHED_SESSION_CONTROL_RELOAD_EXTENSION');
  console.log('BACKUP: '+backup);
} catch(e) {
  fs.copyFileSync(backup,target);
  throw Error('ROLLED_BACK: '+e.message);
}
