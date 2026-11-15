// Explicit operator-provisioned trusted approval authority.
// No secret signing key is stored in this process. OFF by default.
import fs from 'node:fs';
import path from 'node:path';
import {makeChatApprovalVerifier} from '../ai_collaboration/chat-approval-attestation.mjs';
import {createDurableApprovalReplayStore} from '../ai_collaboration/chat-approval-replay-store.mjs';
export function configureSignedChatApproval(env=process.env){
 const enabled=env.PS_DIRECT_CHAT_APPROVAL_ENABLE;
 if(!enabled)return null;
 if(enabled!=='1')throw Error('CHAT_APPROVAL_INVALID_SWITCH');
 const keyPath=env.PS_DIRECT_CHAT_APPROVAL_PUBLIC_KEY_FILE;
 const issuer=env.PS_DIRECT_CHAT_APPROVAL_ISSUER;
 const subject=env.PS_DIRECT_CHAT_APPROVAL_SUBJECT;
 const audience='powershell-direct:engineering-approval';
 const replayDir=env.PS_DIRECT_CHAT_APPROVAL_REPLAY_DIR;
 if(!keyPath||!path.isAbsolute(keyPath)||!issuer||!subject||
    !replayDir||!path.isAbsolute(replayDir))
  throw Error('CHAT_APPROVAL_TRUST_NOT_PROVISIONED');
 const meta=fs.lstatSync(keyPath);
 if(!meta.isFile()||meta.isSymbolicLink())
  throw Error('CHAT_APPROVAL_KEY_NOT_REGULAR_FILE');
 const publicKeyPem=fs.readFileSync(keyPath,'utf8');
 const replayStore=createDurableApprovalReplayStore({directory:replayDir});
 return makeChatApprovalVerifier({publicKeyPem,issuer,audience,subject,replayStore});
}
