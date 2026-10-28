import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decoder } from '../windows-runner-v06/ipc.mjs';
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

