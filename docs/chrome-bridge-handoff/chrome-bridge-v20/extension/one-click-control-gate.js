import { BROWSER_ORIGINS } from './one-click-session.js';

// One-click Control is a session-wide Chrome host grant, not a per-origin timer.
// Validate immediately before every mutation. Revocation outside our UI
// (chrome://extensions) must fail closed even if state flags are stale.
export async function requireOneClickControl(api) {
  const flags=await api.storage.local.get([
    'bridgeConnectionDesired','bridgeAllTabsMode','bridgeMutationLabMode'
  ]);
  if(flags.bridgeConnectionDesired!==true || flags.bridgeAllTabsMode!==true ||
     flags.bridgeMutationLabMode!==true)
    throw Error('ALL_TABS_CONTROL_DISABLED');
  if(typeof api.permissions?.contains!=='function')
    throw Error('HOST_PERMISSION_VERIFICATION_UNAVAILABLE');
  for(const origin of BROWSER_ORIGINS) {
    let permitted=false;
    try { permitted=await api.permissions.contains({origins:[origin]}); }
    catch {throw Error('HOST_PERMISSION_VERIFICATION_FAILED');}
    if(permitted!==true) throw Error('HOST_PERMISSION_REVOKED');
  }
  return true;
}
