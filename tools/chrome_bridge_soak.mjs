// Synthetic endurance tester: creates its own loopback bridge and fake browser; no real AI, keys or existing runtime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import os from 'node:os';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{candidate:{type:'string'},seconds:{type:'string',default:'120'},report:{type:'string'}}});
const seconds=Number(values.seconds);
if(!values.candidate || !Number.isInteger(seconds) || seconds<1 || seconds>3600)throw Error('Use --candidate <source-folder> --seconds <1..3600> [--report <new-file>]');
const candidate=path.resolve(values.candidate);
const reportFile=values.report?path.resolve(values.report):null;
if(reportFile&&fs.existsSync(reportFile))throw Error('REPORT_ALREADY_EXISTS');
const sourceVersion=JSON.parse(fs.readFileSync(path.join(candidate,'package.json'),'utf8')).version;
const root=os.tmpdir();
const {createBridge}=await import(pathToFileURL(path.join(candidate,'server/bridge.mjs')));
const config={agentToken:crypto.randomBytes(32).toString('hex'),browserToken:crypto.randomBytes(32).toString('hex')};
const state=fs.mkdtempSync(path.join(root,'chrome-bridge-synthetic-soak-'));
const server=createBridge(config,{stateDir:state,timeout:2000,pollHold:50,settleMs:1,pollMs:1});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const abort=new AbortController();
let httpCalls=0,browserCalls=0,sends=0,iterations=0,failures=0;
const context={verified:true,origin:'https://claude.ai',conversationId:'soak-conversation-123456'};
let sequence=0;const started=Date.now();const deadline=started+seconds*1000;
const sample=()=>{global.gc?.();const m=process.memoryUsage();return {rss:m.rss,heapUsed:m.heapUsed,fd:process.platform==='linux'?fs.readdirSync('/proc/self/fd').length:null}};
async function post(route,body,token=config.agentToken,headers={},signal){
 httpCalls++;
 return fetch(base+route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:JSON.stringify(body),signal:signal||AbortSignal.timeout(5000)});
}
async function call(method,params={},extra={}){
 const r=await post('/mcp',{jsonrpc:'2.0',id:++sequence,method,params},extra.token,extra.headers);
 if(extra.status){assert.equal(r.status,extra.status);await r.text();return;}
 assert.equal(r.status,200);return r.json();
}
async function tool(name,args={}){const r=await call('tools/call',{name,arguments:args});assert.ok(!r.error);return r.result;}
const pump=(async()=>{
 while(!abort.signal.aborted){
  const r=await post('/bridge/poll',{},config.browserToken,{},abort.signal);assert.equal(r.status,200);
  const {command}=await r.json();if(!command)continue;browserCalls++;
  let result;
  if(command.name==='browser_tabs')result=[{tabId:7,url:'https://claude.ai/chat/soak-conversation-123456',mode:'chat',adapter:'claude'}];
  else if(command.name==='agent_probe')result={verified:true,adapter:'claude'};
  else if(command.name==='agent_context')result=context;
  else if(command.name==='agent_send'){const baseline=sends;sends++;result={baseline,confirmed:true};}
  else if(command.name==='agent_peek')result={count:sends,text:'SYNTHETIC_REPLY_'+sends,generating:false,context};
  else throw Error('Unexpected synthetic command '+command.name);
  const response=await post('/bridge/result',{id:command.id,result},config.browserToken,{},abort.signal);assert.equal(response.status,200);await response.text();
 }
})().catch(error=>{if(!abort.signal.aborted)throw error});
let baseline,peakRss=0,lastReport=0;
const observations=[];
try{
 // Establish the browser connection through the real authenticated protocol.
 await (await post('/bridge/poll',{hello:true},config.browserToken)).json();
 const binding=await tool('agent_bind',{name:'claude',tabId:7});assert.ok(!binding.isError);
 baseline=sample();peakRss=baseline.rss;
 while(Date.now()<deadline){
  const id='soak_'+iterations,text='synthetic local endurance '+iterations;
  const sent=await tool('agent_ask',{name:'claude',text,requestId:id,timeoutSec:1});
  assert.ok(!sent.isError);assert.equal(JSON.parse(sent.content[0].text).done,true);
  const count=sends;
  const duplicate=JSON.parse((await tool('agent_send',{name:'claude',text,requestId:id})).content[0].text);
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.sent,false);assert.equal(sends,count);
  const conflict=await tool('agent_send',{name:'claude',text:text+' changed',requestId:id});assert.equal(conflict.isError,true);assert.equal(sends,count);
  const invalid=await tool('browser_read',{tabId:'invalid'});assert.equal(invalid.isError,true);
  switch(iterations%4){
   case 0:await call('ping',{}, {token:'wrong-synthetic-token',status:401});break;
   case 1:await call('ping',{}, {headers:{Origin:'https://unauthorized.invalid'},status:403});break;
   case 2:{const r=await post('/mcp',[]);assert.equal((await r.json()).error.code,-32600);break;}
   case 3:{const r=await post('/mcp',{jsonrpc:'2.0',method:'notifications/initialized'});assert.equal(r.status,202);await r.text();break;}
  }
  const status=JSON.parse((await tool('browser_status')).content[0].text);assert.equal(status.queued,0);
  iterations++;peakRss=Math.max(peakRss,process.memoryUsage().rss);
  if(Date.now()-lastReport>60000){const current=sample();observations.push({iteration:iterations,elapsedSeconds:Math.round((Date.now()-started)/1000),...current});console.log(JSON.stringify({progress:true,iterations,httpCalls,browserCalls,sends,failures,...current}));lastReport=Date.now();}
  // A new unique request per second exercises sustained state growth and I/O,
  // rather than repeating a completed unit test or calling an external model.
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
}catch(error){failures++;console.error('SOAK_FAILURE',error.message);}
finally{
 abort.abort();await pump;
 await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});
 await new Promise(resolve=>setTimeout(resolve,100));
 const end=sample();peakRss=Math.max(peakRss,end.rss);
 const report={mode:'isolated synthetic endurance; no external AI',sourceVersion,platform:process.platform,nodeVersion:process.version,startedAt:new Date(started).toISOString(),endedAt:new Date().toISOString(),elapsedSeconds:Math.round((Date.now()-started)/1000),iterations,httpCalls,browserCalls,sends,failures,baseline,end,peakRss,observations};
 if(reportFile)fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log('SOAK_COMPLETE',JSON.stringify({...report,observations:observations.length}));
 if(failures)process.exitCode=1;
}
