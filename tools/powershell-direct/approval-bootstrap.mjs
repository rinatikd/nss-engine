// Publish only the UI token, encrypted with Windows CurrentUser DPAPI.
// Never log or return the token. A local operator runs Open-Approval.ps1.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export async function publishApprovalToken(uiToken,{spawnProcess=spawn,platform=process.platform}={}){
  if(platform!=='win32')throw Error('WINDOWS_ONLY_APPROVAL_BOOTSTRAP');
  if(!/^[0-9a-f]{64}$/.test(uiToken))throw Error('INVALID_APPROVAL_TOKEN');
  const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'Save-ApprovalToken.ps1');
  await new Promise((resolve,reject)=>{
    const child=spawnProcess('powershell.exe',
      ['-NoProfile','-NonInteractive','-File',script],
      {stdio:['pipe','ignore','ignore'],windowsHide:true,shell:false});
    let settled=false;
    const finish=(error)=>{
      if(settled)return;settled=true;
      if(error)reject(Error('APPROVAL_BOOTSTRAP_PUBLISH_FAILED'));
      else resolve();
    };
    child.once('error',finish);
    child.once('close',code=>finish(code===0?null:Error('EXIT_NONZERO')));
    child.stdin.on('error',()=>{}); // no unhandled EPIPE on child failure
    child.stdin.end(uiToken+'\n');
  });
}
