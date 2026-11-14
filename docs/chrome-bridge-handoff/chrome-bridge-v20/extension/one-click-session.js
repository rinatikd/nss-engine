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
    const { bridgeConnectionDesired } = await chromeApi.storage.local.get('bridgeConnectionDesired');
    return {
      connected: bridgeConnectionDesired === true && s?.connected === true,
      state: bridgeConnectionDesired !== true ? 'disconnected' :
        s?.connected === true ? 'connected' : 'connecting',
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
      let grantedHere = false;
      try {
        // Chrome's permission prompt can only be triggered from a real user gesture.
        // In particular, do not move this request after awaits.
        const granted = await chromeApi.permissions.request({ origins: BROWSER_ORIGINS });
        const previous = false; // Chrome returns true without another prompt if already granted.
        if (!granted) throw Error('CHROME_HOST_PERMISSION_DENIED');
        grantedHere = !previous;
        const credential = await loadKey(chromeApi);
        if (!credential?.value) throw Error('PAIRING_REQUIRED');
        await chromeApi.storage.local.set({
          bridgeBackgroundMode: true,
          bridgeConnectionDesired: true,
          bridgeMutationLabMode: true
        });
        const result = await start();
        if (!result?.ok) throw Error(result?.reason || 'BRIDGE_START_FAILED');
        if (generation !== myGeneration) throw Error('SESSION_SUPERSEDED');
        // Report "connecting" until the server confirms an active transport.
        return await status();
      } catch (error) {
        await chromeApi.storage.local.set({
          bridgeConnectionDesired: false, bridgeMutationLabMode: false
        });
        if (grantedHere) await chromeApi.permissions.remove({ origins: BROWSER_ORIGINS });
        throw error;
      } finally {
        inFlight = false;
      }
    },
    async disconnect() {
      // Stop dispatch before revoking host permissions, so pending commands
      // cannot run while browser permission removal is in progress.
      ++generation;
      if (inFlight) throw Error('SESSION_TRANSITION_IN_PROGRESS');
      inFlight = true;
      try {
        await chromeApi.storage.local.set({
          bridgeConnectionDesired: false, bridgeMutationLabMode: false
        });
        await stop();
        const revoked = await chromeApi.permissions.remove({ origins: BROWSER_ORIGINS });
        return { connected: false, state: 'disconnected', permissionsRevoked: revoked };
      } finally {
        inFlight = false;
      }
    }
  };
}
