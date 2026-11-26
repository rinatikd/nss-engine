const SERVER_403_CODES = Object.freeze({
  'Invalid Host': 'BRIDGE_HOST_REJECTED_403',
  'Extension Origin denied': 'EXTENSION_ORIGIN_REJECTED_403',
  'Extension ID is not pinned': 'EXTENSION_ID_NOT_PINNED_403'
});

// Return only stable, allow-listed diagnostic codes. Never pass arbitrary
// server response text into UI or logs.
export async function bridgeHttpErrorCode(response) {
  if (response?.status === 401) return 'BROWSER_KEY_REJECTED_401';
  if (response?.status === 403) {
    let serverError = null;
    try {
      const readable = typeof response.clone === 'function' ? response.clone() : response;
      const body = await readable.json();
      if (typeof body?.error === 'string') serverError = body.error;
    } catch { /* Older servers/proxies may return a non-JSON 403 body. */ }
    return SERVER_403_CODES[serverError] || 'BRIDGE_FORBIDDEN_403';
  }
  return 'BRIDGE_HTTP_' + String(response?.status ?? 'UNKNOWN');
}

// One authenticated, read-only handshake before persisting the browser key.
// Uses the existing /bridge/poll endpoint (no server deployment required).
// Successful poll may take ~20s because the existing server uses long polling.
export async function verifyBridgeCredential(fetchImpl, token, {
  endpoint = 'http://127.0.0.1:17381/bridge/poll',
  timeoutMs = 26000
} = {}) {
  if (typeof token !== 'string' || !token.trim()) throw Error('KEY_EMPTY');
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token.trim()
      },
      body: '{}',
      signal
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
      throw Error('BRIDGE_TIMEOUT');
    throw Error('BRIDGE_NETWORK_UNREACHABLE');
  }
  if (response.status === 401 || response.status === 403)
    throw Error(await bridgeHttpErrorCode(response));
  if (!response.ok) throw Error('BRIDGE_HTTP_' + response.status);
  const body = await response.json();
  if (!body || typeof body.epoch !== 'string' || !body.epoch)
    throw Error('BRIDGE_INVALID_HANDSHAKE');
  return { epoch: body.epoch };
}
