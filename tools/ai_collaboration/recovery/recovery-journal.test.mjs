import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, access, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRecoveryJournal} from './recovery-journal.mjs';
async function fixture(f){
 const folder=await mkdtemp(path.join(os.tmpdir(),'cb-recovery-'));
 try{await f(folder);}finally{await rm(folder,{recursive:true,force:true});}
}
test('claim is durable; duplicate request cannot replay',()=>fixture(async folder=>{
 const j=createRecoveryJournal(folder);
 assert.equal((await j.journal({type:'claim',requestId:'recover-0001'})).claimed,true);
 assert.equal((await j.journal({type:'claim',requestId:'recover-0001'})).claimed,false);
 await j.journal({type:'dispatch',requestId:'recover-0001',serviceId:'chrome-pr102-lab'});
 await j.journal({type:'result',requestId:'recover-0001',
   serviceId:'chrome-pr102-lab',outcome:'HEALTHY_AFTER_START'});
 await j.journal({type:'finished',requestId:'recover-0001',outcomes:{}});
 assert.equal((await j.journal({type:'claim',requestId:'recover-0001'})).claimed,false);
 const events=await j.read('recover-0001');
 assert.equal(events.length,4);
}));
test('new independent job may run after clean completion',()=>fixture(async folder=>{
 const j=createRecoveryJournal(folder);
 await j.journal({type:'claim',requestId:'recover-0002'});
 await j.journal({type:'denied',requestId:'recover-0002'});
 assert.equal((await j.journal({type:'claim',requestId:'recover-0003'})).claimed,true);
 await j.journal({type:'finished',requestId:'recover-0003',outcomes:{}});
}));
test('crash before terminal result preserves lock and blocks new dispatch',()=>fixture(async folder=>{
 const j=createRecoveryJournal(folder);
 await j.journal({type:'claim',requestId:'recover-0004'});
 // New journal instance simulates restart after an unknown prior attempt.
 const rebooted=createRecoveryJournal(folder);
 const result=await rebooted.journal({type:'claim',requestId:'recover-0005'});
 assert.equal(result.claimed,false);
 assert.equal(result.reason,'RECOVERY_LOCKED');
 await access(path.join(folder,'recovery.lock'));
}));
test('new journal instance cannot mutate prior active job',()=>fixture(async folder=>{
 const j=createRecoveryJournal(folder);
 await j.journal({type:'claim',requestId:'recover-0006'});
 const rebooted=createRecoveryJournal(folder);
 await assert.rejects(rebooted.journal({
  type:'finished',requestId:'recover-0006',outcomes:{}
 }),/NO_ACTIVE_RECOVERY/);
}));
test('not a general-purpose secret or command log',()=>fixture(async folder=>{
 const j=createRecoveryJournal(folder);
 await j.journal({type:'claim',requestId:'recover-0007'});
 await j.journal({type:'finished',requestId:'recover-0007',
   outcomes:{'chrome-pr102-lab':'ALREADY_HEALTHY'},
   token:'should-never-appear',command:'cmd /c echo unsafe'});
 const raw=await readFile(path.join(folder,'recover-0007.jsonl'),'utf8');
 assert.doesNotMatch(raw,/should-never-appear|cmd \/c/);
}));
