import crypto from 'node:crypto';

export const PROVIDER_TRANSPORT_API_VERSION = '1.0';
const PROVIDERS = new Set(['chatgpt', 'claude', 'deepseek', 'qwen', 'kimi', 'grok', 'gemini']);
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const PREPARE_STATES = new Set(['PREPARED', 'NOT_PERFORMED', 'UNKNOWN']);
const COMMIT_STATES = new Set(['SENT', 'NOT_PERFORMED', 'UNKNOWN']);
const QUERY_STATES = new Set(['PREPARED', 'SENT', 'NOT_PERFORMED', 'UNKNOWN']);

function clone(value) { return structuredClone(value); }
function requireString(value, code, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(code);
  return value;
}
function validateBinding(binding) {
  if (!binding || typeof binding !== 'object' ||
      !(Number.isSafeInteger(binding.tabId) && binding.tabId > 0) ||
      typeof binding.conversationId !== 'string' || !binding.conversationId.trim() || binding.conversationId.length > 512 ||
      !Number.isSafeInteger(binding.epoch) || binding.epoch < 1) throw Error('INVALID_TRANSPORT_BINDING');
  return { tabId: binding.tabId, conversationId: binding.conversationId, epoch: binding.epoch };
}
function sameBinding(a, b) {
  return a.tabId === b.tabId && a.conversationId === b.conversationId && a.epoch === b.epoch;
}
function validateRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw Error('INVALID_TRANSPORT_REQUEST_ID');
  return value;
}
function validateResult(result, { requestId, binding, states, stage }) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('INVALID_TRANSPORT_RESULT');
  if (result.apiVersion !== PROVIDER_TRANSPORT_API_VERSION) throw Error('TRANSPORT_RESULT_VERSION_MISMATCH');
  if (result.requestId !== requestId) throw Error('TRANSPORT_CORRELATION_MISMATCH');
  if (!states.has(result.status)) throw Error('INVALID_TRANSPORT_STATUS');
  const returnedBinding = validateBinding(result.binding);
  if (!sameBinding(returnedBinding, binding)) throw Error('TRANSPORT_BINDING_MISMATCH');
  if (result.status === 'UNKNOWN') {
    requireString(result.quarantineId, 'UNKNOWN_REQUIRES_QUARANTINE_ID', 128);
    return clone(result);
  }
  if (stage === 'prepare' && result.status === 'PREPARED') {
    requireString(result.prepareId, 'PREPARE_ID_REQUIRED', 128);
    requireString(result.fencingToken, 'FENCING_TOKEN_REQUIRED', 512);
    const expiresAt = Date.parse(result.expiresAt);
    if (!Number.isFinite(expiresAt)) throw Error('PREPARE_EXPIRY_REQUIRED');
  }
  if (stage === 'commit' && result.status === 'SENT') requireString(result.deliveryId, 'DELIVERY_ID_REQUIRED', 128);
  return clone(result);
}

/**
 * Wraps a Bridge/API/CLI adapter in the versioned transport contract.
 * UNKNOWN is returned as quarantine state; this wrapper never retries or resends.
 */
export function createProviderTransportV1(adapter) {
  if (!adapter || typeof adapter !== 'object') throw Error('TRANSPORT_ADAPTER_REQUIRED');
  if (adapter.apiVersion !== PROVIDER_TRANSPORT_API_VERSION) throw Error('TRANSPORT_API_VERSION_MISMATCH');
  for (const method of ['prepare', 'commit', 'query', 'revoke']) {
    if (typeof adapter[method] !== 'function') throw Error('TRANSPORT_METHOD_MISSING_' + method.toUpperCase());
  }

  return Object.freeze({
    apiVersion: PROVIDER_TRANSPORT_API_VERSION,

    async prepare(request) {
      if (!request || typeof request !== 'object') throw Error('INVALID_PREPARE_REQUEST');
      const requestId = validateRequestId(request.requestId);
      if (!PROVIDERS.has(request.provider)) throw Error('UNSUPPORTED_PROVIDER');
      const binding = validateBinding(request.binding);
      const content = requireString(request.content, 'TRANSPORT_CONTENT_REQUIRED', 40000);
      if (!HASH.test(request.contentSha256 || '') ||
          crypto.createHash('sha256').update(content, 'utf8').digest('hex') !== request.contentSha256) {
        throw Error('TRANSPORT_CONTENT_HASH_MISMATCH');
      }
      const result = await adapter.prepare(clone({ ...request, requestId, binding, content }));
      return validateResult(result, { requestId, binding, states: PREPARE_STATES, stage: 'prepare' });
    },

    async commit(request) {
      if (!request || typeof request !== 'object') throw Error('INVALID_COMMIT_REQUEST');
      const requestId = validateRequestId(request.requestId);
      const binding = validateBinding(request.binding);
      requireString(request.prepareId, 'PREPARE_ID_REQUIRED', 128);
      requireString(request.fencingToken, 'FENCING_TOKEN_REQUIRED', 512);
      const result = await adapter.commit(clone({ ...request, requestId, binding }));
      return validateResult(result, { requestId, binding, states: COMMIT_STATES, stage: 'commit' });
    },

    async query(request) {
      if (!request || typeof request !== 'object') throw Error('INVALID_QUERY_REQUEST');
      const requestId = validateRequestId(request.requestId);
      const binding = validateBinding(request.binding);
      requireString(request.quarantineId, 'QUARANTINE_ID_REQUIRED', 128);
      const result = await adapter.query(clone({ ...request, requestId, binding }));
      return validateResult(result, { requestId, binding, states: QUERY_STATES, stage: 'query' });
    },

    async revoke(request) {
      if (!request || typeof request !== 'object') throw Error('INVALID_REVOKE_REQUEST');
      const binding = validateBinding(request.binding);
      const reason = requireString(request.reason, 'REVOKE_REASON_REQUIRED', 1000);
      const result = await adapter.revoke(clone({ ...request, binding, reason }));
      if (!result || result.apiVersion !== PROVIDER_TRANSPORT_API_VERSION ||
          !sameBinding(validateBinding(result.binding), binding) || result.revoked !== true ||
          !Number.isSafeInteger(result.nextEpoch) || result.nextEpoch <= binding.epoch) {
        throw Error('INVALID_REVOKE_ATTESTATION');
      }
      return clone(result);
    }
  });
}
