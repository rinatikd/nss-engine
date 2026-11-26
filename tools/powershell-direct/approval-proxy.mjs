import http from 'node:http';
import crypto from 'node:crypto';

const randomHex=()=>crypto.randomBytes(32).toString('hex');
const settlesWithin=(promise,ms)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),ms);Promise.resolve(promise).then(()=>{clearTimeout(timer);resolve(true)},()=>{clearTimeout(timer);resolve(false)});});
const json=(res,status,error)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify({error}));};

export function createApprovalProxy({servicePort=17486,uiToken,nonce=randomHex(),port=0}={}){
 if(!/^[a-f0-9]{64}$/.test(uiToken||''))throw Error('INVALID_UI_TOKEN');
 if(!/^[a-f0-9]{64}$/.test(nonce))throw Error('INVALID_APPROVAL_NONCE');
 const upstreamOrigin='http://127.0.0.1:'+servicePort;
 const server=http.createServer(async(req,res)=>{
  try{
   const address=server.address();
   if(!address||req.headers.host!=='127.0.0.1:'+address.port)return json(res,403,'HOST_DENIED');
   const url=new URL(req.url,'http://127.0.0.1:'+address.port);
   if(url.search||url.hash)return json(res,404,'NOT_FOUND');
   const approvePath='/'+nonce+'/approve',decidePath='/'+nonce+'/decide';
   let upstreamPath;
   if(req.method==='GET'&&url.pathname===approvePath)upstreamPath='/approve';
   else if(req.method==='POST'&&url.pathname===decidePath)upstreamPath='/decide';
   else return json(res,404,'NOT_FOUND');
   if(req.method==='POST'&&req.headers.origin!=='http://127.0.0.1:'+address.port)
    return json(res,403,'ORIGIN_DENIED');
   let body;
   if(req.method==='POST'){
    let size=0;const parts=[];
    for await(const part of req){size+=part.length;if(size>2048)return json(res,413,'BODY_TOO_LARGE');parts.push(part);}
    body=Buffer.concat(parts);
   }
   const headers={authorization:'Bearer '+uiToken};
   if(body){headers['content-type']=req.headers['content-type']||'application/x-www-form-urlencoded';headers.origin=upstreamOrigin;}
   const upstream=await fetch(upstreamOrigin+upstreamPath,{method:req.method,headers,body,signal:AbortSignal.timeout(5000),redirect:'manual'});
   const content=await upstream.arrayBuffer();
   res.writeHead(upstream.status,{
    'content-type':upstream.headers.get('content-type')||'application/octet-stream',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    'x-frame-options':'DENY',
    'referrer-policy':'no-referrer',
    'content-security-policy':"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
   });
   res.end(Buffer.from(content));
  }catch{
   json(res,502,'LOCAL_APPROVAL_UNAVAILABLE');
  }
 });
 return {
  server,nonce,
  start:()=>new Promise((resolve,reject)=>{
   server.once('error',reject);
   server.listen(port,'127.0.0.1',()=>resolve({
    port:server.address().port,
    url:'http://127.0.0.1:'+server.address().port+'/'+nonce+'/approve'
   }));
  }),
  stop:({timeoutMs=5000}={})=>new Promise(resolve=>{
   const closed=new Promise(done=>server.close(()=>done(true)));
   server.closeIdleConnections?.();
   server.closeAllConnections?.();
   settlesWithin(closed,timeoutMs).then(resolve);
  })
 };
}
