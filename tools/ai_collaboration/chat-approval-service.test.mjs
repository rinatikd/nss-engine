import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {PowerShellApprovalService} from '../powershell-direct/service.mjs';
import {makeChatApprovalVerifier,canonicalChatApproval} from './chat-approval-attestation.mjs';
import {createDurableApprovalReplayStore} from './chat-approval-replay-store.mjs';
const requestId='engineering_approval_test_1';
const planSha256='a'.repeat(64);
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const pem=publicKey.export({type:'spki',format:'pem'});
const issuer='trusted-test-attestor',audience='powershell-direct:engineering-approval';
const subject='verified-test-operator';
async function fixture(){
 const directory=await mkdtemp(path.join(os.tmpdir(),'chat-approval-service-'));
 const verify=makeChatApprovalVerifier({
  publicKeyPem:pem,issuer,audience,subject,now:Date.now,
  replayStore:createDurableApprovalReplayStore({directory})
 });
 const service=new PowerShellApprovalService({
  root:'C:\\Engineering\\ChatApprovalTest',port:0,
  engineeringWorkspaceRoots:[directory],engineeringAuditDirectory:directory,
  engineeringChatVerifier:verify
 });
 const payload=(change={})=>({
  audience,decision:'approve',expiresAt:Date.now()+60000,issuedAt:Date.now(),
  issuer,nonce:'nonce_test_approval_1234',planSha256,requestId,subject,version:1,...change
 });
 const signPayload=p=>sign(null,canonicalChatApproval(p),privateKey).toString('base64url');
 let resolved=null;
 const timer=setTimeout(()=>{},90000);timer.unref();
 service.namedPending.set(requestId,{requestId,operation:'engineering-operation',
  planSha256,expiresAt:Date.now()+60000,timer,
  resolve:value=>{resolved=value;}});
 return {service,payload,signPayload,resolved:()=>resolved,
  async cleanup(){clearTimeout(timer);await rm(directory,{recursive:true,force:true});}};
}
test('no verifier configured: signed approval tool not exposed',()=>{
 const s=new PowerShellApprovalService({root:'C:\\Engineering\\ChatApprovalTest',port:0});
 const result=s.rpc({jsonrpc:'2.0',id:1,method:'tools/list'}).result.tools;
 assert.equal(result.some(x=>x.name==='powershell_engineering_approve_signed'),false);
});
test('trusted signature redeems only the exact pending engineering request',async()=>{
 const x=await fixture();
 try{
  const p=x.payload();
  const r=await x.service.redeemSignedEngineeringApproval({
   requestId,payload:p,signatureBase64Url:x.signPayload(p)});
  assert.equal(r.state,'SIGNED_APPROVAL_ACCEPTED_FOR_PENDING_JOB');
  assert.equal(x.resolved()?.reason,'SIGNED_CHAT_APPROVAL');
  await assert.rejects(x.service.redeemSignedEngineeringApproval({
   requestId,payload:p,signatureBase64Url:x.signPayload(p)}),/CHAT_APPROVAL_NOT_PENDING/);
 }finally{await x.cleanup();}
});
test('chat text, wrong signature, expired and altered plan cannot unlock',async()=>{
 const x=await fixture();
 try{
  const p=x.payload();
  await assert.rejects(x.service.redeemSignedEngineeringApproval({
   requestId,payload:p,signatureBase64Url:'user_approved'}),/APPROVAL_SIGNATURE_INVALID/);
  const bad=x.payload({planSha256:'b'.repeat(64)});
  await assert.rejects(x.service.redeemSignedEngineeringApproval({
   requestId,payload:bad,signatureBase64Url:x.signPayload(bad)}),/APPROVAL_CLAIMS_INVALID/);
  assert.equal(x.resolved(),null);
 }finally{await x.cleanup();}
});
test('named suite cannot be approved by engineering signature',async()=>{
 const x=await fixture();
 try{
  x.service.namedPending.get(requestId).operation='execute-named-suite';
  const p=x.payload();
  await assert.rejects(x.service.redeemSignedEngineeringApproval({
   requestId,payload:p,signatureBase64Url:x.signPayload(p)}),/CHAT_APPROVAL_NOT_PENDING/);
 }finally{await x.cleanup();}
});
test('expired pending cannot be redeemed',async()=>{
 const x=await fixture();
 try{
  x.service.namedPending.get(requestId).expiresAt=Date.now()-1;
  const p=x.payload();
  await assert.rejects(x.service.redeemSignedEngineeringApproval({
   requestId,payload:p,signatureBase64Url:x.signPayload(p)}),/CHAT_APPROVAL_NOT_PENDING/);
 }finally{await x.cleanup();}
});
