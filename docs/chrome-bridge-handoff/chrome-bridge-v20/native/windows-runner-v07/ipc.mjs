import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export function decoder(onMessage) {
  if (typeof onMessage !== 'function') throw Error('INVALID_DECODER_CALLBACK');
  let buffer = Buffer.alloc(0);
  let ended = false;
  return {
    push(chunk) {
      if (ended) throw Error('DECODER_ENDED');
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length < 1 || length > 4096) throw Error('FRAME_LIMIT');
        if (buffer.length < length + 4) break;
        const payload = buffer.subarray(4, length + 4);
        const text = payload.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(payload)) throw Error('INVALID_UTF8');
        let value;
        try { value = JSON.parse(text); } catch { throw Error('INVALID_JSON'); }
        onMessage(value);
        buffer = buffer.subarray(length + 4);
      }
      if (buffer.length > 4100) throw Error('FRAME_LIMIT');
    },
    end() {
      ended = true;
      if (buffer.length) throw Error('TRUNCATED_FRAME');
    }
  };
}
const executable = fileURLToPath(new URL('./broker.exe', import.meta.url));
export function wire(text) { const b=Buffer.from(text); if(!b.length||b.length>4096)throw Error('FRAME_LIMIT');const h=Buffer.alloc(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b]); }
export function nativeRequest(args={}) {
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['op','text','timeoutMs','signal'].includes(k)))throw Error('INVALID_REQUEST');
 const {op='echo',text='',timeoutMs=1000,signal}=args;
 if(!['echo','hold','crash','flood'].includes(op)||typeof text!=='string'||Buffer.byteLength(text)>1024||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>5000||(signal!==undefined&&!(signal instanceof AbortSignal)))throw Error('INVALID_REQUEST');
 const id=randomUUID();
 return new Promise((resolve,reject)=>{
 const child=spawn(executable,[],{env:{SystemRoot:process.env.SystemRoot,LOCALAPPDATA:process.env.LOCALAPPDATA},stdio:['pipe','pipe','pipe'],windowsHide:true});let result=null,error=null,bytes=0;
 const abort=()=>{if(child.stdin.writable)child.stdin.write(wire(`cancel|${id}`));};
 const read=decoder(m=>{if(result||Object.keys(m).sort().join(',')!=='empty,hex,id,isolated,status,v'||m.v!==1||m.id!==id||m.isolated!==true||m.empty!==true||!['succeeded','failed','cancelled','timed_out'].includes(m.status)||typeof m.hex!=='string'||!/^(?:[0-9a-f]{2}){0,1024}$/.test(m.hex)||m.hex!==(m.status==='succeeded'?Buffer.from(text).toString('hex'):''))throw Error('INVALID_RESPONSE');result={id,status:m.status,...(m.status==='succeeded'?{text:Buffer.from(m.hex,'hex').toString()}:{}),isolated:true,empty:true};});
 const timer=setTimeout(()=>{error=Error('SUPERVISOR_TIMEOUT_UNVERIFIED');child.kill();},timeoutMs+8000);
 child.stdout.on('data',b=>{try{read.push(b);}catch(e){error=e;child.kill();}});
 child.stderr.on('data',b=>{bytes+=b.length;if(bytes>2048){error=Error('LOG_LIMIT');child.kill();}});
 child.stdin.on('error',()=>{});child.on('error',e=>{error=e;});
 child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);try{read.end();}catch(e){error=e;}if(error||code!==0||!result)reject(error??Error('NATIVE_FAIL_CLOSED'));else resolve(result);});
 child.stdin.write(wire(`${id}|${op}|${timeoutMs}|${Buffer.from(text).toString('hex')}`));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}


