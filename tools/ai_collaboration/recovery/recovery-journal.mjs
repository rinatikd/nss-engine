// Durable, fail-closed recovery claim and audit. A stale lock is NOT
// automatically removed: after a crash, operator must inspect it before retry.
// All paths are trusted local configuration, never supplied by web clients.
import { mkdir, open, appendFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const ID=/^[a-zA-Z0-9_-]{8,80}$/;
export function createRecoveryJournal(directory) {
  if(typeof directory!=='string'||!path.isAbsolute(directory))
    throw Error('AUDIT_DIR_NOT_ABSOLUTE');
  let activeId=null;
  const fileFor=id=>path.join(directory,id+'.jsonl');
  const journal=async event=>{
    const id=event?.requestId;
    if(typeof id!=='string'||!ID.test(id))throw Error('INVALID_REQUEST_ID');
    const allowed=new Set(['claim','denied','dispatch','result','finished']);
    if(!allowed.has(event.type))throw Error('INVALID_JOURNAL_EVENT');
    await mkdir(directory,{recursive:true,mode:0o700});
    if(event.type==='claim'){
      if(activeId!==null)return {claimed:false,reason:'ANOTHER_RECOVERY_RUNNING'};
      let fh;
      try{fh=await open(fileFor(id),'wx',0o600);}catch(e){
        if(e.code==='EEXIST')return {claimed:false,reason:'DUPLICATE_REQUEST_ID'};
        throw e;
      }
      // A separate global lock prevents two different IDs from concurrently
      // dispatching against the same services across independent processes.
      let lock;
      try{lock=await open(path.join(directory,'recovery.lock'),'wx',0o600);}
      catch(e){await fh.close();return {claimed:false,reason:'RECOVERY_LOCKED'};}
      try{
        await lock.writeFile(JSON.stringify({requestId:id,at:event.at})+'\n');
        await lock.sync();
        await fh.writeFile(JSON.stringify({type:'claim',requestId:id,at:event.at})+'\n');
        await fh.sync();
      }finally{await lock.close();await fh.close();}
      activeId=id;
      return {claimed:true};
    }
    if(activeId!==id)throw Error('NO_ACTIVE_RECOVERY');
    // No tokens, paths or command strings in the audit.
    const payload={type:event.type,requestId:id,at:Date.now()};
    if(event.serviceId)payload.serviceId=event.serviceId;
    if(event.outcome)payload.outcome=event.outcome;
    if(event.type==='finished'&&event.outcomes)payload.outcomes=event.outcomes;
    await appendFile(fileFor(id),JSON.stringify(payload)+'\n',{encoding:'utf8'});
    if(event.type==='finished'||event.type==='denied'){
      // Only a fully journaled terminal outcome releases the global lock.
      // After a crash the lock remains and forces manual reconciliation.
      const lockPath=path.join(directory,'recovery.lock');
      const lockInfo=JSON.parse((await readFile(lockPath,'utf8')).trim());
      if(lockInfo.requestId!==id)throw Error('LOCK_OWNERSHIP_MISMATCH');
      await unlink(lockPath);
      activeId=null;
    }
    return {recorded:true};
  };
  return {journal,async read(id){
    if(!ID.test(id))throw Error('INVALID_REQUEST_ID');
    try{return (await readFile(fileFor(id),'utf8')).split('\n').filter(Boolean).map(JSON.parse);}
    catch(e){if(e.code==='ENOENT')return [];throw e;}
  }};
}
