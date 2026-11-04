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
  if (response.status === 401) throw Error('BROWSER_KEY_REJECTED_401');
  if (response.status === 403) throw Error('EXTENSION_ORIGIN_REJECTED_403');
  if (!response.ok) throw Error('BRIDGE_HTTP_' + response.status);
  const body = await response.json();
  if (!body || typeof body.epoch !== 'string' || !body.epoch)
    throw Error('BRIDGE_INVALID_HANDSHAKE');
  return { epoch: body.epoch };
}
