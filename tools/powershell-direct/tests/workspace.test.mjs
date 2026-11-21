import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {canonicalWorkspace,canonicalRoot} from '../runner.mjs';
import {PowerShellApprovalService} from '../service.mjs';

// Fake Windows file system: alias map emulates junction / subst resolution.
// realpath returns the on-disk spelling (registered case, no trailing separator).
function fakeFs({dirs=[],files=[],alias={},denied=[]}={}){
 const norm=p=>path.win32.normalize(p).replace(/\\+$/,'');
 const key=p=>norm(p).toLowerCase();
 const CANON=new Map([...dirs,...files].map(x=>[key(x),norm(x)]));
 const D=new Set(dirs.map(key)),F=new Set(files.map(key));
 const A=new Map(Object.entries(alias).map(([k,v])=>[key(k),norm(v)]));
 const err=code=>Object.assign(new Error(code+': synthetic C:\\secret\\path'),{code});
 const real=p=>{
  const n=norm(p),k=key(p);
  if(denied.some(d=>k.startsWith(key(d))))throw err('EPERM');
  const hit=[...A.keys()].find(a=>k===a||k.startsWith(a+'\\'));
  const out=hit?norm(A.get(hit)+n.slice(hit.length)):n;
  const o=key(out);
  if(!D.has(o)&&!F.has(o))throw err('ENOENT');
  return CANON.get(o)??out;
 };
 return {realpathSync:{native:real},statSync:p=>({isDirectory:()=>D.has(key(p))})};
}
const W={platform:'win32'};
const check=(c,r,fsImpl)=>canonicalWorkspace(c,r,{...W,fsImpl});
const base=()=>fakeFs({dirs:['C:\\Engineering','C:\\Engineering\\NSS','C:\\Engineering\\..odd','C:\\Windows','C:\\Windows\\System32','D:\\Repos\\X'],files:['C:\\Engineering\\file.txt']});

test('accepts root itself, children, forward slashes and case differences',()=>{
 const f=base();
 assert.equal(check('C:\\Engineering','C:\\Engineering',f),'C:\\Engineering');
 assert.equal(check('C:/Engineering/NSS','C:\\Engineering',f),'C:\\Engineering\\NSS'); // canonical form, as realpath returns
 assert.equal(check('c:\\ENGINEERING\\nss\\','C:\\Engineering',f),'C:\\Engineering\\NSS');
 assert.equal(check('C:\\Engineering\\..odd','C:\\Engineering',f),'C:\\Engineering\\..odd'); // name starting with '..' is not traversal
});
test('rejects outside root, sibling-prefix, other drive, traversal',()=>{
 const f=fakeFs({dirs:['C:\\Engineering','C:\\EngineeringX','C:\\Windows','D:\\Repos']});
 for(const c of ['C:\\Windows','C:\\EngineeringX','D:\\Repos','C:\\Engineering\\..\\Windows'])
  assert.throws(()=>check(c,'C:\\Engineering',f),/WORKSPACE_OUTSIDE_ALLOWED_ROOT/,c);
});
test('junction leaving the root is judged by its real target',()=>{
 const f=fakeFs({dirs:['C:\\Engineering','C:\\Engineering\\Link','D:\\Repos\\X'],alias:{'C:\\Engineering\\Link':'D:\\Repos\\X'}});
 assert.throws(()=>check('C:\\Engineering\\Link','C:\\Engineering',f),/WORKSPACE_OUTSIDE_ALLOWED_ROOT/);
});
test('aliased root: workspace reached through the alias is accepted consistently',()=>{
 const f=fakeFs({dirs:['C:\\Engineering','D:\\Real','D:\\Real\\NSS'],alias:{'C:\\Engineering':'D:\\Real'}});
 assert.equal(check('C:\\Engineering\\NSS','C:\\Engineering',f),'D:\\Real\\NSS');
});
test('syntactic rejections: relative, UNC, drive-relative, non-string',()=>{
 const f=base();
 for(const c of ['NSS','\\\\srv\\share\\x','C:NSS',undefined,42,'/c/Engineering/NSS'])
  assert.throws(()=>check(c,'C:\\Engineering',f),/WORKSPACE_NOT_ABSOLUTE/,String(c));
});
test('stable codes instead of raw fs errors; no path leaks',()=>{
 const f=fakeFs({dirs:['C:\\Engineering'],files:['C:\\Engineering\\file.txt'],denied:['C:\\Engineering\\Locked']});
 assert.throws(()=>check('C:\\Engineering\\missing','C:\\Engineering',f),e=>e.message==='WORKSPACE_NOT_FOUND');
 assert.throws(()=>check('C:\\Engineering\\file.txt','C:\\Engineering',f),e=>e.message==='WORKSPACE_NOT_DIRECTORY');
 assert.throws(()=>check('C:\\Engineering\\Locked','C:\\Engineering',f),e=>e.message==='WORKSPACE_UNREADABLE');
 assert.throws(()=>check('C:\\Engineering','C:\\Gone',f),e=>e.message==='ROOT_NOT_FOUND');
});
test('non-Windows platform fails closed',()=>{
 assert.throws(()=>canonicalWorkspace('C:\\Engineering','C:\\Engineering',{platform:'linux',fsImpl:base()}),/WINDOWS_ONLY/);
 assert.throws(()=>canonicalRoot('C:\\Engineering',{platform:'linux',fsImpl:base()}),/WINDOWS_ONLY/);
});
test('root junction to a system directory is refused by the service',()=>{
 const f=fakeFs({dirs:['C:\\Engineering','C:\\Windows\\System32\\Work'],alias:{'C:\\Engineering':'C:\\Windows\\System32\\Work'}});
 assert.throws(()=>new PowerShellApprovalService({root:'C:\\Engineering',port:0,resolveRoot:r=>canonicalRoot(r,{...W,fsImpl:f})}),/SAFE_ROOT_AND_PORT_REQUIRED/);
 const g=fakeFs({dirs:['C:\\Engineering','D:\\']});
 assert.throws(()=>new PowerShellApprovalService({root:'C:\\Engineering',port:0,resolveRoot:()=>'D:\\'}),/SAFE_ROOT_AND_PORT_REQUIRED/);
});
test('service stores the real root and passes it to the workspace check',()=>{
 const f=fakeFs({dirs:['C:\\Engineering','D:\\Real','D:\\Real\\NSS'],alias:{'C:\\Engineering':'D:\\Real'}});
 let seen;
 const s=new PowerShellApprovalService({root:'C:\\Engineering',port:0,resolveRoot:r=>canonicalRoot(r,{...W,fsImpl:f}),
  workspaceCheck:(c,r)=>{seen=r;return check(c,r,f);}});
 assert.equal(s.root,'D:\\Real');
 s.propose({requestId:'realroot0001',task:'git-status',workspace:'C:\\Engineering\\NSS'});
 assert.equal(seen,'D:\\Real');
});
test('MCP client sees only the stable code for a missing workspace',()=>{
 const f=fakeFs({dirs:['C:\\Engineering']});
 const s=new PowerShellApprovalService({root:'C:\\Engineering',port:0,resolveRoot:r=>r,workspaceCheck:(c,r)=>check(c,r,f)});
 const r=s.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'powershell_propose',arguments:{requestId:'missing00001',task:'git-status',workspace:'C:\\Engineering\\nope'}}});
 assert.equal(r.result.isError,true);assert.equal(r.result.content[0].text,'WORKSPACE_NOT_FOUND');
});
