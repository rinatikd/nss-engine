import crypto from 'node:crypto';
import { CONTROL_ORIGINS } from '../../extension/permissions.js';

export const PROVIDER_TRANSPORT_V1 = 'consilium.provider-transport/v1';
export const SEND_STATES = Object.freeze([
  'ACCEPTED', 'PREPARED', 'DISPATCHED', 'SENT', 'DELIVERED', 'REPLIED', 'VERIFIED',
  'UNKNOWN', 'NOT_PERFORMED', 'BLOCKED', 'STOP_REQUESTED', 'STOPPED_CLEAN', 'STOP_AFTER_COMMIT', 'REVOKED'
]);
const ID = /^[A-Za-z0-9_-]{8,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDERS = new Set(Object.values(CONTROL_ORIGINS));

export class TransportContractError extends Error {
  constructor(code) { super(code); this.name = 'TransportContractError'; this.code = code; }
}

function requiredString(value, code, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TransportContractError(code);
  return value;
}
function equalIdentity(a, b) {
  return a.requestId === b.requestId && a.taskId === b.taskId &&
    a.providerId === b.providerId && a.tabId === b.tabId &&
    a.origin === b.origin && a.conversationId === b.conversationId && a.epoch === b.epoch;
}

export function validateTransportIdentity(input) {
  if (!input || typeof input !== 'object') throw new TransportContractError('IDENTITY_REQUIRED');
  if (!ID.test(input.requestId || '') || !ID.test(input.taskId || '')) throw new TransportContractError('REQUEST_OR_TASK_ID_INVALID');
  if (!PROVIDERS.has(input.providerId)) throw new TransportContractError('PROVIDER_NOT_IN_COUNCIL');
  if (typeof input.tabId !== 'number' || !Number.isSafeInteger(input.tabId) || input.tabId <= 0) throw new TransportContractError('TAB_ID_INVALID');
  if (CONTROL_ORIGINS[input.origin] !== input.providerId) throw new TransportContractError('ORIGIN_PROVIDER_MISMATCH');
  if (typeof input.conversationId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(input.conversationId)) throw new TransportContractError('CONVERSATION_ID_INVALID');
  if (typeof input.epoch !== 'number' || !Number.isSafeInteger(input.epoch) || input.epoch < 1) throw new TransportContractError('FENCING_EPOCH_INVALID');
  return Object.freeze({
    requestId: input.requestId, taskId: input.taskId, providerId: input.providerId,
    tabId: input.tabId, origin: input.origin, conversationId: input.conversationId, epoch: input.epoch
  });
}

function validateState(result, expected, allowed) {
  if (!result || typeof result !== 'object' || !allowed.includes(result.state)) throw new TransportContractError('TRANSPORT_STATE_INVALID');
  if (!result.identity || !equalIdentity(result.identity, expected)) throw new TransportContractError('TRANSPORT_IDENTITY_MISMATCH');
  if (result.state === 'UNKNOWN') requiredString(result.quarantineId, 'UNKNOWN_QUARANTINE_ID_REQUIRED', 128);
  return result;
}

function validateReplyReceipt(receipt, identity) {
  if (!receipt || !receipt.identity || !equalIdentity(receipt.identity, identity) ||
      receipt.requestId !== identity.requestId || receipt.taskId !== identity.taskId ||
      receipt.providerId !== identity.providerId || receipt.tabId !== identity.tabId ||
      receipt.origin !== identity.origin || receipt.conversationId !== identity.conversationId ||
      receipt.epoch !== identity.epoch || !Number.isSafeInteger(receipt.baseline) || receipt.baseline < 0 ||
      receipt.replyIndex !== receipt.baseline + 1 || !Number.isFinite(Date.parse(receipt.clickedAt || '')) ||
      !Number.isFinite(Date.parse(receipt.observedAt || '')) ||
      Date.parse(receipt.observedAt) < Date.parse(receipt.clickedAt) ||
      !SHA256.test(receipt.replySha256 || '') || !Number.isSafeInteger(receipt.replyChars) ||
      receipt.replyChars < 1 || receipt.replyChars > 100000 || receipt.stableSamples !== 2 ||
      !ID.test(receipt.eventId || '') || !SHA256.test(receipt.recordHash || '') ||
      !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
    throw new TransportContractError('REPLY_RECEIPT_INVALID');
  }
  return receipt;
}

export class ProviderTransport {
  constructor(adapter, { verifyQuiescence = async () => false } = {}) {
    if (!adapter || adapter.version !== PROVIDER_TRANSPORT_V1) throw new TransportContractError('TRANSPORT_VERSION_UNSUPPORTED');
    if (typeof verifyQuiescence !== 'function') throw new TransportContractError('QUIESCENCE_VERIFIER_REQUIRED');
    this.verifyQuiescence = verifyQuiescence;
    for (const method of ['prepare', 'commit', 'status', 'replyWait', 'stop', 'revoke', 'events']) {
      if (typeof adapter[method] !== 'function') throw new TransportContractError('TRANSPORT_METHOD_MISSING_' + method.toUpperCase());
    }
    this.adapter = adapter;
  }

  async prepare(input) {
    const identity = validateTransportIdentity(input);
    requiredString(input.message, 'MESSAGE_REQUIRED', 100000);
    const payloadHash = requiredString(input.payloadHash, 'PAYLOAD_HASH_REQUIRED', 64);
    if (!SHA256.test(payloadHash)) throw new TransportContractError('PAYLOAD_HASH_INVALID');
    if (crypto.createHash('sha256').update(input.message, 'utf8').digest('hex') !== payloadHash) throw new TransportContractError('PAYLOAD_HASH_MISMATCH');
    const result = await this.adapter.prepare({ ...identity, message: input.message, payloadHash });
    validateState(result, identity, ['PREPARED', 'BLOCKED', 'NOT_PERFORMED', 'UNKNOWN']);
    if (result.state === 'PREPARED') {
      requiredString(result.preparedId, 'PREPARED_ID_REQUIRED', 128);
      requiredString(result.fencingToken, 'FENCING_TOKEN_REQUIRED', 512);
      if (result.requestId !== identity.requestId || result.payloadHash !== payloadHash) {
        throw new TransportContractError('PREPARE_CORRELATION_INVALID');
      }
      const expiresAt = Date.parse(result.expiresAt || '');
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new TransportContractError('PREPARE_EXPIRY_INVALID');
      if (result.sideEffect !== 'composer-filled-no-send') throw new TransportContractError('PREPARE_SIDE_EFFECT_INVALID');
      if (result.clickedSend !== false) throw new TransportContractError('PREPARE_MUST_NOT_CLICK_SEND');
    }
    return result;
  }

  async commit(input) {
    const identity = validateTransportIdentity(input);
    requiredString(input.preparedId, 'PREPARED_ID_REQUIRED', 128);
    requiredString(input.fencingToken, 'FENCING_TOKEN_REQUIRED', 512);
    const payloadHash = requiredString(input.payloadHash, 'PAYLOAD_HASH_REQUIRED', 64);
    if (!SHA256.test(payloadHash)) throw new TransportContractError('PAYLOAD_HASH_INVALID');
    const result = await this.adapter.commit({
      ...identity, preparedId: input.preparedId, fencingToken: input.fencingToken, payloadHash
    });
    validateState(result, identity, ['SENT', 'BLOCKED', 'NOT_PERFORMED', 'UNKNOWN']);
    if (result.state === 'SENT') {
      if (!Number.isFinite(Date.parse(result.clickedAt || '')) || result.clickedSend !== true) {
        throw new TransportContractError('COMMIT_CLICK_EVIDENCE_REQUIRED');
      }
      if (result.requestId !== identity.requestId || result.preparedId !== input.preparedId ||
          result.payloadHash !== payloadHash) throw new TransportContractError('COMMIT_CORRELATION_INVALID');
    }
    return result;
  }

  async status(input) {
    const identity = validateTransportIdentity(input);
    const result = await this.adapter.status(identity);
    validateState(result, identity, SEND_STATES);
    if (result.state === 'PREPARED') {
      requiredString(result.preparedId, 'PREPARED_ID_REQUIRED', 128);
      requiredString(result.fencingToken, 'FENCING_TOKEN_REQUIRED', 512);
      if (result.requestId !== identity.requestId || !SHA256.test(result.payloadHash || '') ||
          result.sideEffect !== 'composer-filled-no-send' || result.clickedSend !== false ||
          !Number.isFinite(Date.parse(result.expiresAt || '')) || Date.parse(result.expiresAt) <= Date.now()) {
        throw new TransportContractError('PREPARED_STATUS_INVALID');
      }
    }
    if (result.state === 'SENT' && (result.requestId !== identity.requestId ||
        !Number.isFinite(Date.parse(result.clickedAt || '')) || result.clickedSend !== true ||
        !ID.test(result.preparedId || '') || !SHA256.test(result.payloadHash || ''))) {
      throw new TransportContractError('SENT_STATUS_INVALID');
    }
    if (result.state === 'REPLIED') validateReplyReceipt(result.replyReceipt, identity);
    return result;
  }

  async replyWait(input) {
    const identity = validateTransportIdentity(input);
    const timeoutSec = input.timeoutSec === undefined ? 45 : input.timeoutSec;
    if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 2 || timeoutSec > 55) {
      throw new TransportContractError('REPLY_TIMEOUT_INVALID');
    }
    const result = await this.adapter.replyWait(identity, timeoutSec);
    validateState(result, identity, ['REPLIED', 'UNKNOWN', 'BLOCKED', 'NOT_PERFORMED']);
    if (result.state === 'REPLIED') {
      const receipt=validateReplyReceipt(result.replyReceipt, identity);
      if (typeof result.reply !== 'string' || result.reply.length !== receipt.replyChars ||
          crypto.createHash('sha256').update(result.reply, 'utf8').digest('hex') !== receipt.replySha256) {
        throw new TransportContractError('REPLY_TEXT_RECEIPT_MISMATCH');
      }
    }
    return result;
  }

  async stop(input) {
    const identity = validateTransportIdentity(input);
    const result = await this.adapter.stop(identity);
    validateState(result, identity, ['STOP_REQUESTED', 'STOPPED_CLEAN', 'STOP_AFTER_COMMIT', 'UNKNOWN']);
    if (['STOP_REQUESTED', 'STOP_AFTER_COMMIT'].includes(result.state) &&
        (!Number.isSafeInteger(result.nextEpoch) || result.nextEpoch <= identity.epoch)) {
      throw new TransportContractError('STOP_FENCING_EPOCH_INVALID');
    }
    if (result.state === 'STOPPED_CLEAN') {
      const proof = result.quiescence;
      if (!proof || proof.verified !== true || proof.signatureValid !== true ||
          proof.epoch !== identity.epoch || !Number.isSafeInteger(proof.nextEpoch) || proof.nextEpoch <= identity.epoch ||
          proof.unresolved !== 0 || proof.outstandingPrepared !== 0 ||
          !ID.test(proof.attestationId || '') || typeof proof.signature !== 'string' || proof.signature.length < 32 ||
          await this.verifyQuiescence(proof, identity) !== true) {
        throw new TransportContractError('STOP_QUIESCENCE_ATTESTATION_INVALID');
      }
    }
    return result;
  }

  async revoke(input) {
    const identity = validateTransportIdentity(input);
    const result = await this.adapter.revoke(identity);
    if (result?.state === 'UNKNOWN') {
      validateState(result, identity, ['UNKNOWN']);
      if (!Number.isSafeInteger(result.nextEpoch) || result.nextEpoch <= identity.epoch) {
        throw new TransportContractError('FENCING_REVOKE_ATTESTATION_INVALID');
      }
      return result;
    }
    if (!result || result.state !== 'REVOKED' || !result.identity || !equalIdentity(result.identity, identity) ||
        !Number.isSafeInteger(result.nextEpoch) || result.nextEpoch <= identity.epoch) {
      throw new TransportContractError('FENCING_REVOKE_ATTESTATION_INVALID');
    }
    return result;
  }

  async events({ after = 0, limit = 100 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TransportContractError('EVENT_WINDOW_INVALID');
    }
    const result = await this.adapter.events({ after, limit });
    if (!Array.isArray(result)) throw new TransportContractError('EVENTS_RESPONSE_INVALID');
    let sequence = after;
    for (const event of result) {
      if (!event || !Number.isSafeInteger(event.seq) || event.seq <= sequence ||
          !ID.test(event.eventId || '') || !ID.test(event.requestId || '') ||
          !SEND_STATES.includes(event.state) || !PROVIDERS.has(event.providerId)) {
        throw new TransportContractError('TRANSPORT_EVENT_INVALID');
      }
      const eventIdentity = validateTransportIdentity(event.identity);
      if (eventIdentity.requestId !== event.requestId || eventIdentity.providerId !== event.providerId) {
        throw new TransportContractError('TRANSPORT_EVENT_IDENTITY_MISMATCH');
      }
      if (event.state === 'UNKNOWN') requiredString(event.quarantineId, 'UNKNOWN_QUARANTINE_ID_REQUIRED', 128);
      sequence = event.seq;
    }
    if (result.length > limit) throw new TransportContractError('EVENT_LIMIT_EXCEEDED');
    return result;
  }
}
