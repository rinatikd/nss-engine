// Safety contract for a future dedicated PowerShell MCP channel.
// This module does NOT spawn any process. It produces signed-by-hash immutable
// job proposals for a separately reviewed, locally approved executor.
import crypto from 'node:crypto';
import path from 'node:path';

const TTL_MS=90_000;
export const TASKS=Object.freeze({
  'git-status': Object.freeze({ exe:'git.exe', argv:['status','--short','--branch'], readOnly:true }),
  'git-diff-check': Object.freeze({ exe:'git.exe', argv:['diff','--check'], readOnly:true }),
  'dotnet-version': Object.freeze({ exe:'dotnet.exe', argv:['--version'], readOnly:true }),
  'node-version': Object.freeze({ exe:'node.exe', argv:['--version'], readOnly:true })
});
const stableJson=v=>JSON.stringify(v);
const stamp=(obj)=>crypto.createHash('sha256').update(stableJson(obj)).digest('hex');
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(id);
const canonicalDir=dir=>{
  if(typeof dir!=='string'||dir.length>260||!path.win32.isAbsolute(dir))throw Error('ABSOLUTE_WORKSPACE_REQUIRED');
  const normalized=path.win32.normalize(dir);
  if (normalized.startsWith('\\\\') || normalized.includes('..') ||
      /(?:^|\\)(?:windows|system32|appdata|program files)(?:\\|$)/i.test(normalized))
    throw Error('UNSAFE_WORKSPACE');
  return normalized;
};
export function proposeTask({requestId,task,workspace,now=Date.now()}){
  if(!validId(requestId))throw Error('INVALID_REQUEST_ID');
  if(!Object.hasOwn(TASKS,task))throw Error('TASK_NOT_ALLOWED');
  if(!Number.isSafeInteger(now))throw Error('INVALID_TIME');
  const command=TASKS[task];
  const payload=Object.freeze({
    version:1,requestId,task,
    workspace:canonicalDir(workspace),
    exe:command.exe,argv:[...command.argv],
    readOnly:command.readOnly,
    issuedAt:now,expiresAt:now+TTL_MS
  });
  return Object.freeze({payload,sha256:stamp(payload)});
}
export function verifyApprovedTask(proposal,approval,{now=Date.now()}={}){
  if(!proposal?.payload||typeof proposal.sha256!=='string'||!approval)
    throw Error('APPROVAL_MISSING');
  if(proposal.sha256!==stamp(proposal.payload))throw Error('PROPOSAL_CHANGED');
  if(proposal.payload.expiresAt<=now||proposal.payload.issuedAt>now)throw Error('APPROVAL_EXPIRED');
  if(approval.approved!==true||approval.requestId!==proposal.payload.requestId ||
     approval.sha256!==proposal.sha256||approval.localGesture!==true)
    throw Error('EXACT_LOCAL_APPROVAL_REQUIRED');
  const expected=TASKS[proposal.payload.task];
  if(!expected||expected.exe!==proposal.payload.exe||
     stableJson(expected.argv)!==stableJson(proposal.payload.argv)||
     expected.readOnly!==proposal.payload.readOnly)
    throw Error('COMMAND_NOT_ALLOWED');
  if(canonicalDir(proposal.payload.workspace)!==proposal.payload.workspace)
    throw Error('WORKSPACE_CHANGED');
  return Object.freeze({...proposal.payload});
}
