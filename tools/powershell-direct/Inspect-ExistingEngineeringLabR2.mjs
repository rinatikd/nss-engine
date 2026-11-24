// Read-only forensic inspection of the pre-existing R2 stage.
// Emits paths, manifest field names and hash parity only; never file contents or secrets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const source='C:/Engineering/ChromeBridge-Recovery-Install-20261114/work/PowerShellDirect-PR138-pinned-release-clean';
const stage='C:/Engineering/PowerShellDirect-Engineering-Lab-R2';
const git='C:/Program Files/Git/cmd/git.exe';
const result={check:'R2_EXISTING_STAGE_READ_ONLY_INSPECTION',source,stage,readOnly:true,productionTouched:false};

const gitResult=spawnSync(git,['-C',source,'ls-files','--','tools/powershell-direct','tools/ai_collaboration'],{
  cwd:source,encoding:'utf8',timeout:15000,windowsHide:true
});
if(gitResult.status!==0) throw new Error('GIT_INVENTORY_FAILED');
const tracked=gitResult.stdout.split(/\r?\n/).filter(Boolean).sort();
result.trackedCount=tracked.length;

function walk(root){
  const files=[];
  const symlinks=[];
  function visit(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const full=path.join(dir,entry.name);
      if(entry.isSymbolicLink()){symlinks.push(path.relative(root,full).split(path.sep).join('/'));continue;}
      if(entry.isDirectory())visit(full);
      else if(entry.isFile())files.push(path.relative(root,full).split(path.sep).join('/'));
      else throw new Error('UNSUPPORTED_ENTRY');
    }
  }
  visit(root);
  return {files:files.sort(),symlinks};
}
result.stageExists=fs.existsSync(stage);
if(!result.stageExists){result.error='R2_STAGE_MISSING';console.log(JSON.stringify(result));process.exit(0);}
const tree=walk(stage);
result.stageFileCount=tree.files.length;
result.stageSymlinkCount=tree.symlinks.length;
result.stageUnexpectedFirst=tree.files.filter(x=>!tracked.includes(x)).slice(0,20);
result.stageMissingFirst=tracked.filter(x=>!tree.files.includes(x)).slice(0,20);

const manifestPath=path.join(stage,'source-hashes.json');
result.manifestExists=fs.existsSync(manifestPath);
if(!result.manifestExists){result.error='R2_MANIFEST_MISSING';console.log(JSON.stringify(result));process.exit(0);}
const parsed=JSON.parse(fs.readFileSync(manifestPath,'utf8').replace(/^\uFEFF/,''));
result.manifestType=Array.isArray(parsed)?'array':typeof parsed;
const rows=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.files)?parsed.files:Array.isArray(parsed?.entries)?parsed.entries:null);
result.manifestTopKeys=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?Object.keys(parsed).slice(0,30):[];
result.manifestRowCount=rows?.length??null;
result.manifestSample=rows?.slice(0,3).map(row=>{
 if(typeof row==='string')return {kind:'string',value:row.slice(0,180)};
 if(!row||typeof row!=='object')return {kind:typeof row};
 return {keys:Object.keys(row).slice(0,20),
  pathValue:row.File??row.file??row.path??row.relativePath??row.relative_path??null,
  hashPresent:Boolean(row.Sha256??row.sha256??row.hash??row.Hash)};
})??null;
const getFile=row=>typeof row==='string'?row:(row?.File??row?.file??row?.path??row?.relativePath??row?.relative_path);
const getHash=row=>typeof row==='object'?(row?.Sha256??row?.sha256??row?.hash??row?.Hash):null;
if(rows){
 const names=rows.map(getFile).filter(x=>typeof x==='string').sort();
 result.manifestNamedCount=names.length;
 result.manifestMissingNames=tracked.filter(x=>!names.includes(x)).slice(0,20);
 result.manifestExtraNames=names.filter(x=>!tracked.includes(x)).slice(0,20);
 let checked=0, mismatch=[];
 for(const row of rows){
  const rel=getFile(row), expectedHash=getHash(row);
  if(!rel||!expectedHash||!tracked.includes(rel))continue;
  const src=path.join(source,rel),dst=path.join(stage,rel);
  if(!fs.existsSync(src)||!fs.existsSync(dst)){mismatch.push({file:rel,reason:'FILE_MISSING'});continue;}
  const a=crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  const b=crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex');
  if(a.toLowerCase()!==String(expectedHash).toLowerCase()||b.toLowerCase()!==String(expectedHash).toLowerCase())
    mismatch.push({file:rel,reason:'HASH_MISMATCH'});
  checked++;
 }
 result.hashEntriesChecked=checked;
 result.hashMismatchesFirst=mismatch.slice(0,20);
}
result.inventoryExact=tree.symlinks.length===0&&tree.files.length===tracked.length&&
 tracked.every((x,i)=>tree.files[i]===x);
console.log(JSON.stringify(result));
