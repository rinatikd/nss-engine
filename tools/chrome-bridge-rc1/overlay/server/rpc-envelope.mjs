// Validate the bridge's object-parameter JSON-RPC dialect before dispatch.
// Invalid envelopes receive an error even when they omit an id; only valid
// envelopes without an id are notifications whose replies must be suppressed.
export function validateRpcEnvelope(message) {
  const invalid = () => ({
    ok: false,
    response: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
  });
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      message.jsonrpc !== '2.0' || typeof message.method !== 'string') return invalid();
  const hasId = Object.hasOwn(message, 'id');
  if (hasId && typeof message.id !== 'string' &&
      !(typeof message.id === 'number' && Number.isFinite(message.id))) return invalid();
  if (Object.hasOwn(message, 'params') &&
      (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) return invalid();
  return hasId ? { ok: true, notification: false, id: message.id } : { ok: true, notification: true };
}
