// Durable one-use grant nonce claims. Never reuse an expired/consumed nonce.
// Intended only for a separately trusted user-attestation verifier.
import {createHash} from 'node:crypto';
import {mkdir,open,lstat} from 'node:fs/promises';
import path from 'node:path';
// Hash the key before using it as a filename. No path separators or controls.
const ID=/^[a-zA-Z0-9_.:@-]{12,512}$/;
export function createDurableApprovalReplayStore({directory,now=Date.now}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||
    typeof now!=='function')throw Error('REPLAY_DIR_REQUIRED');
 return Object.freeze({
  async consumeOnce(key,expiresAt){
   if(typeof key!=='string'||!ID.test(key)||
      !Number.isSafeInteger(expiresAt)||expiresAt<=now())
    throw Error('REPLAY_INVALID_INPUT');
   await mkdir(directory,{recursive:true,mode:0o700});
   const root=await lstat(directory);
   if(!root.isDirectory()||root.isSymbolicLink())
    throw Error('REPLAY_STORAGE_NOT_DIRECTORY');
   const filename=createHash('sha256').update(key).digest('hex')+'.claim';
   const target=path.join(directory,filename);
   let file;
   try{file=await open(target,'wx',0o600);}
   catch(e){if(e.code==='EEXIST')return false;throw e;}
   try{
    await file.writeFile(JSON.stringify({version:1,expiresAt}));
    await file.sync();
   }finally{await file.close();}
   // Never remove claims automatically: an old approval must stay consumed,
   // even after a service restart or clock correction.
   return true;
  }
 });
}
