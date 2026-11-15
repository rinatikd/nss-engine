// One-click browser permission/session lifecycle. This module is deliberately
// independent of the legacy per-origin Control buttons. It does not execute
// browser commands: the coordinator remains the authority for dispatch.
export const BROWSER_ORIGINS = Object.freeze(['http://*/*', 'https://*/*']);

export function eligibleWebUrl(raw) {
  try {
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') &&
      !['chrome.google.com', 'chromewebstore.google.com'].includes(u.hostname);
  } catch { return false; }
}

export function createOneClickSession(chromeApi, {
  loadKey,
  start,
  stop,
  getStatus
}) {
  let inFlight = false;
  let generation = 0;
  const status = async () => {
    const s = await getStatus();
    const { bridgeConnectionDesired, bridgeAllTabsMode, bridgeMutationLabMode } =
      await chromeApi.storage.local.get([
        'bridgeConnectionDesired', 'bridgeAllTabsMode', 'bridgeMutationLabMode'
      ]);
    if (bridgeConnectionDesired !== true)
      return { connected: false, state: 'disconnected', error: s?.error || null };
    if (bridgeAllTabsMode !== true || bridgeMutationLabMode !== true)
      return { connected: false, state: 'permission-revoked', error: 'ALL_TABS_CONTROL_DISABLED' };
    // Chrome permissions may be revoked from chrome://extensions while the
    // transport is still healthy. Never report "Подключено" in this state.
    if (typeof chromeApi.permissions.contains !== 'function')
      return { connected: false, state: 'permission-revoked',
        error: 'HOST_PERMISSION_VERIFICATION_UNAVAILABLE' };
    try {
      for (const origin of BROWSER_ORIGINS) {
        if (!(await chromeApi.permissions.contains({ origins: [origin] })))
          return { connected: false, state: 'permission-revoked', error: 'HOST_PERMISSION_REVOKED' };
      }
    } catch {
      return { connected: false, state: 'permission-revoked',
        error: 'HOST_PERMISSION_VERIFICATION_FAILED' };
    }
    return {
      connected: s?.connected === true,
      state: s?.connected === true ? 'connected' : 'connecting',
      error: s?.error || null
    };
  };
  return {
    status,
    async connect({ trustedGesture = false } = {}) {
      if (!trustedGesture) throw Error('LOCAL_GESTURE_REQUIRED');
      if (inFlight) throw Error('SESSION_TRANSITION_IN_PROGRESS');
      inFlight = true;
      const myGeneration = ++generation;
      try {
        // Chrome's permission prompt can only be triggered from a real user gesture.
        // In particular, do not move this request after awaits.
        const granted = await chromeApi.permissions.request({ origins: BROWSER_ORIGINS });
        if (!granted) throw Error('CHROME_HOST_PERMISSION_DENIED');
        const credential = await loadKey(chromeApi);
        if (!credential?.value) throw Error('PAIRING_REQUIRED');
        await chromeApi.storage.local.set({
          bridgeBackgroundMode: true,
          bridgeConnectionDesired: true,
          bridgeMutationLabMode: true,
          bridgeAllTabsMode: true
        });
        const result = await start();
        if (!result?.ok) throw Error(result?.reason || 'BRIDGE_START_FAILED');
        if (generation !== myGeneration) throw Error('SESSION_SUPERSEDED');
        // Report "connecting" until the server confirms an active transport.
        return await status();
      } catch (error) {
        await chromeApi.storage.local.set({
          bridgeConnectionDesired: false, bridgeMutationLabMode: false,
          bridgeAllTabsMode: false
        });
        // Preserve previously granted Chrome permissions on failed startup.
        // A single explicit Disconnect revokes them. We cannot know whether
        // request() was a new grant without a prior async permission query,
        // which can break Chrome's required transient user activation.
        throw error;
      } finally {
        inFlight = false;
      }
    },
    async disconnect() {
      // Stop dispatch before revoking host permissions, so pending commands
      // cannot run while browser permission removal is in progress.
      if (inFlight) throw Error('SESSION_TRANSITION_IN_PROGRESS');
      ++generation;
      inFlight = true;
      try {
        await chromeApi.storage.local.set({
          bridgeConnectionDesired: false, bridgeMutationLabMode: false,
          bridgeAllTabsMode: false
        });
        let stopError = null;
        try { await stop(); } catch (error) { stopError = error; }
        // Host permissions must be revoked even if the transport cannot ACK.
        let revoked = false;
        let revokeError = null;
        try { revoked = await chromeApi.permissions.remove({ origins: BROWSER_ORIGINS }); }
        catch (error) { revokeError = error; }
        if (revokeError) throw Error('HOST_PERMISSION_REVOKE_FAILED: ' + revokeError.message);
        // Verify every requested host scope independently; contains() with
        // both scopes would miss a partially retained permission.
        if (typeof chromeApi.permissions.contains !== 'function')
          throw Error('HOST_PERMISSION_VERIFICATION_UNAVAILABLE');
        for (const origin of BROWSER_ORIGINS) {
          const stillGranted = await chromeApi.permissions.contains({ origins: [origin] });
          if (stillGranted) throw Error('HOST_PERMISSION_REMAINED_GRANTED');
        }
        if (stopError) throw Error('BACKGROUND_STOP_UNCONFIRMED: ' + stopError.message);
        return { connected: false, state: 'disconnected', permissionsRevoked: true };
      } finally {
        inFlight = false;
      }
    }
  };
}
