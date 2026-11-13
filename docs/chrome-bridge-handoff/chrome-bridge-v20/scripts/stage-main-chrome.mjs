import fs from 'node:fs';
import path from 'node:path';

// Standalone opt-in stage operation. No profile, token, or running bridge writes.
if (process.argv.length !== 6) throw Error('USAGE: node stage-main-chrome.mjs SOURCE_DIR NEW_OUTPUT_DIR MANIFEST_FILE UNIQUE_PORT');
const source=path.resolve(process.argv[2]);
const output=path.resolve(process.argv[3]||'');
const manifest=path.resolve(process.argv[4]||'');
const port=Number(process.argv[5]);
const reserved=new Set([17381,17382,17481,17482,17483,17484]);
if (!Number.isSafeInteger(port)||port<1024||port>65535||reserved.has(port))
  throw Error('INVALID_OR_RESERVED_PORT');
if (source===output||output.startsWith(source+path.sep)||source.startsWith(output+path.sep))
  throw Error('SOURCE_OUTPUT_OVERLAP');
if (!fs.statSync(source).isDirectory()||fs.existsSync(output))
  throw Error('SOURCE_INVALID_OR_OUTPUT_EXISTS');
const m=JSON.parse(fs.readFileSync(manifest,'utf8'));
const endpoint='http://127.0.0.1:'+port;
if (m.manifest_version!==3||m.background?.service_worker!=='background.js'||
    m.background?.type!=='module'||
    JSON.stringify(m.host_permissions)!==JSON.stringify([endpoint+'/*']))
  throw Error('MV3_MANIFEST_OR_HOST_PERMISSIONS_MISMATCH');
const optional=new Set(['https://claude.ai/*','https://grok.com/*']);
if (!Array.isArray(m.optional_host_permissions)||
    m.optional_host_permissions.length!==2||
    !m.optional_host_permissions.every(x=>optional.has(x)))
  throw Error('OPTIONAL_HOST_PERMISSIONS_NOT_SCOPED');
const swap={
  'control.js':"const BRIDGE = 'http://127.0.0.1:17381';",
  'connection-check.js':"endpoint = 'http://127.0.0.1:17381/bridge/poll',",
  'transport-engine.js':"const DEFAULT_ENDPOINT = 'http://127.0.0.1:17381';"
};
const files=fs.readdirSync(source,{withFileTypes:true});
const staged=new Map();
for (const entry of files) {
  if (!entry.isFile()||!/^[-a-z0-9_.]+\.(js|mjs|html|css|png|svg|ico|webp)$/i.test(entry.name)||
      /(?:^|[._-])(?:token|credential|private|api-key)(?:[._-]|$)/i.test(entry.name))
    throw Error('UNSAFE_SOURCE_ENTRY: '+entry.name);
  if (entry.name==='manifest.json') continue;
  let data=fs.readFileSync(path.join(source,entry.name));
  if (Object.hasOwn(swap,entry.name)) {
    const old=swap[entry.name],newText=old.replace('17381',String(port));
    const parts=data.toString('utf8').split(old);
    if (parts.length!==2) throw Error('ENDPOINT_PATTERN_MISMATCH: '+entry.name);
    data=Buffer.from(parts.join(newText));
  }
  if (entry.name.endsWith('.js')&&data.toString('utf8').includes('127.0.0.1:17381'))
    throw Error('PRODUCTION_ENDPOINT_REMAINS: '+entry.name);
  staged.set(entry.name,data);
}
for (const required of Object.keys(swap)) if(!staged.has(required))
  throw Error('MISSING_REQUIRED_FILE: '+required);
fs.mkdirSync(output);
for (const [name,data] of staged)
  fs.writeFileSync(path.join(output,name),data,{flag:'wx'});
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(m,null,2)+'\n',{flag:'wx'});
console.log('STAGED_NOT_INSTALLED port='+port+' files='+(staged.size+1));
