import { ProviderTransport, PROVIDER_TRANSPORT_V1 } from './provider-transport-v1.mjs';
import { deriveProviderJournalKey, verifyQuiescence } from '../../server/provider-transport-crypto.mjs';

const ID = /^[A-Za-z0-9_-]{8,100}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,80}$/;

export class ChromeBridgeAdapterError extends Error {
  constructor(code, { dispatchState = null, ambiguous = false } = {}) {
    super(code);
    this.name = 'ChromeBridgeAdapterError';
    this.code = code;
    this.dispatchState = dispatchState;
    this.ambiguous = ambiguous;
  }
}

function normalizeEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ChromeBridgeAdapterError('BRIDGE_ENDPOINT_REQUIRED');
  let url;
  try { url = new URL(value); } catch { throw new ChromeBridgeAdapterError('BRIDGE_ENDPOINT_INVALID'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      !url.port || url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '/mcp')) {
    throw new ChromeBridgeAdapterError('BRIDGE_ENDPOINT_MUST_BE_LOOPBACK');
  }
  return url.origin + '/mcp';
}

function requiredToken(value) {
  if (typeof value !== 'string' || value.length < 32 || value.trim() !== value) {
    throw new ChromeBridgeAdapterError('BRIDGE_AGENT_TOKEN_INVALID');
  }
  return value;
}

function rpcResult(payload) {
  if (!payload || payload.jsonrpc !== '2.0' || payload.error || !payload.result) {
    throw new ChromeBridgeAdapterError('BRIDGE_RPC_RESPONSE_INVALID', { ambiguous: true });
  }
  const block = payload.result.content?.find(item => item?.type === 'text');
  if (payload.result.isError === true) {
    const code = typeof block?.text === 'string' && SAFE_CODE.test(block.text)
      ? block.text : 'BRIDGE_TOOL_REJECTED';
    throw new ChromeBridgeAdapterError(code, {
      dispatchState: ['BLOCKED', 'NOT_PERFORMED'].includes(payload.result.dispatchState)
        ? payload.result.dispatchState : null,
      ambiguous: payload.result.dispatchState !== 'BLOCKED' &&
        payload.result.dispatchState !== 'NOT_PERFORMED'
    });
  }
  if (typeof block?.text !== 'string') throw new ChromeBridgeAdapterError('BRIDGE_TOOL_RESPONSE_MISSING', { ambiguous: true });
  try { return JSON.parse(block.text); }
  catch { throw new ChromeBridgeAdapterError('BRIDGE_TOOL_RESPONSE_INVALID', { ambiguous: true }); }
}

export function createQuiescenceVerifier(agentToken) {
  const key = deriveProviderJournalKey(requiredToken(agentToken));
  return async (proof, identity) => verifyQuiescence(proof, identity, key);
}

/**
 * Concrete Node-side adapter for the Chrome Bridge MCP server.
 *
 * It never retries a mutation. A lost/ambiguous HTTP acknowledgement becomes
 * UNKNOWN with a stable quarantine ID. Read-only status/events remain separate.
 */
export class ChromeBridgeProviderAdapter {
  constructor({ endpoint, agentToken, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    this.version = PROVIDER_TRANSPORT_V1;
    this.endpoint = normalizeEndpoint(endpoint);
    this.agentToken = requiredToken(agentToken);
    if (typeof fetchImpl !== 'function') throw new ChromeBridgeAdapterError('BRIDGE_FETCH_REQUIRED');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
      throw new ChromeBridgeAdapterError('BRIDGE_TIMEOUT_INVALID');
    }
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.timeoutMs = timeoutMs;
    this.rpcSequence = 0;
  }

  async callTool(name, args, requestId = null) {
    const rpcId = requestId ? 'provider-' + name + '-' + requestId : 'provider-' + name + '-' + (++this.rpcSequence);
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.agentToken
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId,
          method: 'tools/call',
          params: { name, arguments: args }
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new ChromeBridgeAdapterError(timeout ? 'BRIDGE_REQUEST_TIMEOUT' : 'BRIDGE_NETWORK_UNREACHABLE', {
        ambiguous: true
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new ChromeBridgeAdapterError('BRIDGE_AUTH_ORIGIN_DENIED', { dispatchState: 'BLOCKED' });
    }
    if (response.status >= 400 && response.status < 500) {
      throw new ChromeBridgeAdapterError('BRIDGE_REQUEST_REJECTED', { dispatchState: 'NOT_PERFORMED' });
    }
    if (!response.ok) {
      throw new ChromeBridgeAdapterError('BRIDGE_SERVER_UNAVAILABLE', { ambiguous: true });
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new ChromeBridgeAdapterError('BRIDGE_RPC_RESPONSE_INVALID', { ambiguous: true }); }
    if (payload?.id !== rpcId) throw new ChromeBridgeAdapterError('BRIDGE_RPC_CORRELATION_MISMATCH', { ambiguous: true });
    return rpcResult(payload);
  }

  async mutation(name, identity, args = {}) {
    try {
      return await this.callTool(name, { ...identity, ...args }, identity.requestId);
    } catch (error) {
      if (error?.dispatchState === 'BLOCKED') return { state: 'BLOCKED', identity, reasonCode: error.code };
      if (error?.dispatchState === 'NOT_PERFORMED') return { state: 'NOT_PERFORMED', identity, reasonCode: error.code };
      return {
        state: 'UNKNOWN',
        identity,
        quarantineId: 'quarantine-' + identity.requestId,
        reasonCode: SAFE_CODE.test(error?.code || '') ? error.code : 'BRIDGE_OUTCOME_UNKNOWN'
      };
    }
  }

  prepare({ requestId, taskId, providerId, tabId, origin, conversationId, epoch, message, payloadHash }) {
    return this.mutation('provider_prepare',
      { requestId, taskId, providerId, tabId, origin, conversationId, epoch },
      { message, payloadHash });
  }

  commit({ requestId, taskId, providerId, tabId, origin, conversationId, epoch, preparedId, fencingToken, payloadHash }) {
    return this.mutation('provider_commit',
      { requestId, taskId, providerId, tabId, origin, conversationId, epoch },
      { preparedId, fencingToken, payloadHash });
  }

  async status(identity) {
    try { return await this.callTool('provider_status', identity, identity.requestId); }
    catch (error) {
      return { state: 'UNKNOWN', identity, quarantineId: 'quarantine-' + identity.requestId,
        reasonCode: SAFE_CODE.test(error?.code || '') ? error.code : 'BRIDGE_STATUS_UNKNOWN' };
    }
  }

  async replyWait(identity, timeoutSec = 45) {
    try { return await this.callTool('provider_reply_wait', { ...identity, timeoutSec }, identity.requestId); }
    catch (error) {
      return { state: 'UNKNOWN', identity, quarantineId: 'quarantine-' + identity.requestId,
        reasonCode: SAFE_CODE.test(error?.code || '') ? error.code : 'BRIDGE_REPLY_UNKNOWN' };
    }
  }

  stop(identity) {
    return this.mutation('provider_stop', identity);
  }

  revoke(identity) {
    return this.mutation('provider_revoke', identity);
  }

  async events({ after = 0, limit = 100 } = {}) {
    return this.callTool('provider_events', { after, limit });
  }
}

export function createChromeBridgeProviderTransport(options) {
  const adapter = new ChromeBridgeProviderAdapter(options);
  return new ProviderTransport(adapter, {
    verifyQuiescence: createQuiescenceVerifier(options?.agentToken)
  });
}
