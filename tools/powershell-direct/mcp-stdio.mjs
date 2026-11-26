// Stdio MCP adapter for the isolated localhost PowerShell approval service.
// Each input line is one JSON-RPC message. No token is ever logged.
import readline from 'node:readline';
const endpoint='http://127.0.0.1:17486/mcp';
const token=process.env.PS_DIRECT_AGENT_TOKEN;
if(!token||!/^[a-f0-9]{64}$/.test(token))throw Error('PS_DIRECT_AGENT_TOKEN_REQUIRED');
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});
for await(const line of rl){
 if(!line.trim())continue;
 let req;
 try{req=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({
  jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');continue;}
 try{
  const response=await fetch(endpoint,{method:'POST',
   headers:{'content-type':'application/json',Authorization:'Bearer '+token},
   body:JSON.stringify(req),signal:AbortSignal.timeout(15000)});
  if(response.status===202)continue;
  if(!response.ok)throw Error('LOCAL_MCP_HTTP_'+response.status);
  const answer=await response.json();
  process.stdout.write(JSON.stringify(answer)+'\n');
 }catch{
  if(req.id!=null)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,
   error:{code:-32000,message:'LOCAL_POWERSHELL_SERVICE_UNAVAILABLE'}})+'\n');
 }
}
