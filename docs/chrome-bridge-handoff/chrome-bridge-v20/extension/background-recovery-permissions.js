// Keep this check independent of transport startup. A missing or revoked
// session-wide Chrome host grant must never silently restart an old session.
export async function canRecoverAllTabsSession(api) {
  const flags=await api.storage.local.get([
    'bridgeBackgroundMode','bridgeConnectionDesired','bridgeAllTabsMode'
  ]);
  if(flags.bridgeBackgroundMode!==true || flags.bridgeConnectionDesired!==true)
    return false;
  if(flags.bridgeAllTabsMode!==true) return true; // legacy mode unchanged
  if(typeof api.permissions?.contains!=='function') return false;
  try {
    for(const origin of ['http://*/*','https://*/*']) {
      if(!(await api.permissions.contains({origins:[origin]}))) return false;
    }
  } catch {return false;}
  return true;
}
