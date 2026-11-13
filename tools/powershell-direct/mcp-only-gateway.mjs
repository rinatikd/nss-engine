// Explicit MCP-only relay; never forwards /approve or /decide.
// Bind on loopback, front with a separately authorized private HTTPS tunnel.
// Does not start any process and does not consume Codex CLI quota.
import http from 'node:http';
import crypto from 'node:crypto';

const SERVICE='http://127.0.0.1:17486/mcp';
const PORT=17487;
const secret=process.env.PS_DIRECT_AGENT_TOKEN;
const gatewayToken=process.env.PS_DIRECT_GATEWAY_TOKEN;
if(!/^[a-f0-9]{64}$/.test(secret||'')||!/^[a-f0-9]{64}$/.test(gatewayToken||''))
 throw Error('TWO_DISTINCT_64_HEX_TOKENS_REQUIRED');
if(secret===gatewayToken)throw Error('GATEWAY_TOKEN_MUST_BE_DIFFERENT');
const eq=(a,b)=>{
 const x=Buffer.from(typeof a==='string'?a:''),y=Buffer.from(b);
 return x.length===y.length&&crypto.timingSafeEqual(x,y);
};
const json=(res,code,obj)=>{
 res.writeHead(code,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});
 res.end(JSON.stringify(obj));
};
const srv=http.createServer(async(req,res)=>{
 try {
  if(req.headers.host!==`127.0.0.1:${PORT}`)return json(res,403,{error:'HOST_DENIED'});
  if(req.method!=='POST'||req.url!=='/mcp')return json(res,404,{error:'MCP_ONLY'});
  if(req.headers.origin)return json(res,403,{error:'BROWSER_ORIGIN_DENIED'});
  if(!eq(req.headers.authorization,'Bearer '+gatewayToken))
   return json(res,401,{error:'UNAUTHORIZED'});
  let size=0,bufs=[];
  for await(const part of req){size+=part.length;if(size>8192)return json(res,413,{error:'BODY_TOO_LARGE'});bufs.push(part);}
  const response=await fetch(SERVICE,{
   method:'POST',
   headers:{'content-type':'application/json','authorization':'Bearer '+secret},
   body:Buffer.concat(bufs),
   signal:AbortSignal.timeout(20000)
  });
  const body=await response.text();
  res.writeHead(response.status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(body.slice(0,65536));
 }catch{json(res,502,{error:'LOCAL_MCP_UNAVAILABLE'});}
});
srv.listen(PORT,'127.0.0.1',()=>console.error('MCP_GATEWAY_READY 127.0.0.1:'+PORT+' /mcp ONLY'));
