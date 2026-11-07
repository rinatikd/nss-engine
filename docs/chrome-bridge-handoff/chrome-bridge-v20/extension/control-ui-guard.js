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

async function refresh() {
  const current=++generation;
  let connected=false;
  try {
    if (mode.checked) {
      const status=await chrome.runtime.sendMessage({target:'bridge-coordinator',type:'status'});
      connected=!!(status && status.connected===true && status.state==='connected');
    }
  } catch { connected=false; }
  if (disposed || current!==generation) return;
  const state=backgroundControlUiState({
    backgroundMode:mode.checked,connected,mutationEnabled:lab.checked
  });
  grantAll.disabled=state.grantAllDisabled;
  grantAll.title=state.reason;
  revokeAll.disabled=!mode.checked;
  if (prerequisites) prerequisites.textContent=state.reason;
}
for (const input of [mode,lab]) input.addEventListener('change',()=>{void refresh();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
const interval=setInterval(()=>{void refresh();},2500);
window.addEventListener('beforeunload',()=>{disposed=true;clearInterval(interval);});
void refresh();
