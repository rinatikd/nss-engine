import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOVERY_HOST, requestLocalRecovery, formatRecoverySummary
} from '../extension/recovery-native.js';

test('fixed host identity and fixed restore action',async()=>{
  let captured;
  const chrome={runtime:{
    lastError:null,
    sendNativeMessage(host,body,cb){
      captured={host,body};
      cb({ok:true,servers:[{id:'chrome-pr102-lab',state:'ALREADY_LISTENING'}],
        connections:[]});
    }
  }};
  const r=await requestLocalRecovery(chrome);
  assert.equal(r.ok,true);
  assert.equal(captured.host,RECOVERY_HOST);
  assert.deepEqual(captured.body,{action:'restore'});
  assert.match(formatRecoverySummary(r),/chrome-pr102-lab/);
});

test('cannot supply arbitrary native host command via action',async()=>{
  let calls=0;
  const chrome={runtime:{sendNativeMessage(){calls++;}}};
  await assert.rejects(
    requestLocalRecovery(chrome,'powershell -Command whoami'),
    /ACTION_NOT_ALLOWED/
  );
  assert.equal(calls,0);
});

test('native host absence fails clearly without claiming recovery',async()=>{
  const chrome={runtime:{
    lastError:{message:'Native host not found'},
    sendNativeMessage(_host,_body,cb){cb(undefined);}
  }};
  await assert.rejects(
    requestLocalRecovery(chrome,'restore'),
    /NATIVE_HOST_NOT_INSTALLED_OR_UNAVAILABLE/
  );
});

test('host error must not be converted to success',async()=>{
  const chrome={runtime:{
    lastError:null,
    sendNativeMessage(_host,_body,cb){cb({ok:false,error:'RECOVERY_TIMEOUT'});}
  }};
  await assert.rejects(requestLocalRecovery(chrome),/RECOVERY_TIMEOUT/);
});

test('returned host message is bounded and rendered as text only',async()=>{
  const chrome={runtime:{
    lastError:null,
    sendNativeMessage(_h,_b,cb){cb({ok:true,
      servers:Array.from({length:100},()=>({id:'test',state:'OK'})),
      connections:[{id:'<script>',state:'<script>'}]});}
  }};
  const r=await requestLocalRecovery(chrome);
  assert.equal(r.servers.length,20);
  assert.doesNotMatch(formatRecoverySummary(r),/<script>/);
});
