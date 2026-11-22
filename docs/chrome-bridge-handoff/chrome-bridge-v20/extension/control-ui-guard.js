import { backgroundControlUiState } from './background-control-ui-state.js';

// Presentation-only guard: coordinator remains authoritative for every grant.
const grantAll=document.getElementById('backgroundGrantAll');
const revokeAll=document.getElementById('backgroundRevokeAll');
const prerequisites=document.getElementById('backgroundGrantPrerequisite');
const mode=document.getElementById('backgroundMode');
const lab=document.getElementById('mutationLab');
let disposed=false;
let generation=0;
// The grant coordinator is authoritative; never infer a successful revoke from a click.
export async function refreshBackgroundControlButtons() { await refresh(); }
window.addEventListener('bridge-background-grants-changed',()=>{void refresh();});
chrome.storage?.onChanged?.addListener((changes,areaName)=>{
  if (areaName==='local') {
    if (changes.bridgeBackgroundMode)
      mode.checked=changes.bridgeBackgroundMode.newValue===true;
    if (changes.bridgeMutationLabMode)
      lab.checked=changes.bridgeMutationLabMode.newValue===true;
  }
  if ((areaName==='local' &&
       (changes.bridgeBackgroundMode || changes.bridgeMutationLabMode ||
        changes.bridgeConnectionDesired)) ||
      (areaName==='session' && changes.bridgeBackgroundControlGrants)) void refresh();
});

async function refresh() {
  const current=++generation;
  let connected=false;
  let activeCount=0;
  let grantsKnown=false;
  try {
    const [status, grants]=await Promise.all([
      chrome.runtime.sendMessage({target:'bridge-coordinator',type:'status'}),
      chrome.runtime.sendMessage({target:'bridge-coordinator',type:'background-control-status'})
    ]);
    if (typeof grants?.backgroundMode==='boolean') mode.checked=grants.backgroundMode;
    if (typeof grants?.mutationEnabled==='boolean') lab.checked=grants.mutationEnabled;
    connected=!!(status && status.connected===true && status.state==='connected' &&
      grants?.connected===true);
    if (Number.isSafeInteger(grants?.activeCount) && grants.activeCount>=0 &&
        grants?.grantsKnown!==false) {
      activeCount=grants.activeCount;
      grantsKnown=true;
    }
  } catch { connected=false; }
  if (disposed || current!==generation) return;
  const state=backgroundControlUiState({
    backgroundMode:mode.checked,connected,mutationEnabled:lab.checked,activeCount,grantsKnown
  });
  grantAll.disabled=state.grantAllDisabled;
  grantAll.title=state.reason;
  revokeAll.disabled=state.revokeAllDisabled;
  revokeAll.title=activeCount>0 ? 'Отозвать '+activeCount+' временных разрешений' : state.reason;
  if (prerequisites) prerequisites.textContent=state.reason;
}
for (const input of [mode,lab]) input.addEventListener('change',()=>{void refresh();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
const interval=setInterval(()=>{void refresh();},2500);
window.addEventListener('beforeunload',()=>{disposed=true;clearInterval(interval);});
void refresh();
