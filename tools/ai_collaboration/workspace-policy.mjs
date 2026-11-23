// Canonical per-job workspace selection. No persistent workspace allowlist.
// The exact resolved directory is included in the immutable approval plan.
// Windows account ACLs remain the filesystem boundary; protected OS locations
// and volume roots are denied. Symlink/junction aliases resolve before approval.
import fs from 'node:fs';
import path from 'node:path';

const same = (a,b,win) => win
  ? path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase()
  : path.normalize(a) === path.normalize(b);

function isWithin(candidate,parent,mod,win) {
  const relative=mod.relative(parent,candidate);
  if(relative===''||relative==='.')return true;
  const prefix='..'+mod.sep;
  return relative!=='..'&&!relative.startsWith(prefix)&&!mod.isAbsolute(relative);
}

export function canonicalUserWorkspace(candidate,{
  platform=process.platform,env=process.env,
  realpath=fs.realpathSync.native,stat=fs.statSync
}={}) {
  const win=platform==='win32';
  const mod=win?path.win32:path;
  if(typeof candidate!=='string'||!mod.isAbsolute(candidate))
    throw Error('WORKSPACE_NOT_ABSOLUTE');
  if(win){
    const normalizedCandidate=mod.normalize(candidate);
    if(normalizedCandidate.toLowerCase().startsWith('\\\\?\\globalroot')||
       normalizedCandidate.startsWith('\\\\.\\'))
      throw Error('WORKSPACE_DEVICE_PATH_DENIED');
    if(normalizedCandidate.startsWith('\\\\'))
      throw Error('WORKSPACE_NETWORK_PATH_DENIED');
  }
  let actual;
  try{actual=realpath(candidate);}catch{throw Error('WORKSPACE_NOT_FOUND');}
  let info;
  try{info=stat(actual);}catch{throw Error('WORKSPACE_NOT_FOUND');}
  if(!info.isDirectory())throw Error('WORKSPACE_NOT_DIRECTORY');
  if(win){
    const volumeRoot=mod.parse(actual).root;
    if(volumeRoot&&same(actual,volumeRoot,true))throw Error('WORKSPACE_VOLUME_ROOT_DENIED');
    const protectedValues=[
      env.SystemRoot,env.WINDIR,env.ProgramFiles,env['ProgramFiles(x86)'],env.ProgramW6432
    ].filter(value=>typeof value==='string'&&mod.isAbsolute(value));
    for(const value of protectedValues){
      let protectedRoot;
      try{protectedRoot=realpath(value);}catch{continue;}
      if(isWithin(actual,protectedRoot,mod,true))
        throw Error('WORKSPACE_PROTECTED_SYSTEM_LOCATION');
    }
  }
  return actual;
}
