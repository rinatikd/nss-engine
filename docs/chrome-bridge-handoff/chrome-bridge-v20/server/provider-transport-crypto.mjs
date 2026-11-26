import crypto from 'node:crypto';

export function deriveProviderJournalKey(agentToken) {
  if (typeof agentToken !== 'string' || agentToken.length < 32 || agentToken.trim() !== agentToken) {
    throw Error('PROVIDER_JOURNAL_KEY_INVALID');
  }
  return crypto.createHmac('sha256', 'chrome-bridge/provider-journal/v1')
    .update(agentToken, 'utf8').digest();
}

export function quiescencePayload(proof, identity) {
  return JSON.stringify({
    purpose: 'chrome-bridge/provider-quiescence/v1',
    requestId: identity.requestId,
    taskId: identity.taskId,
    providerId: identity.providerId,
    tabId: identity.tabId,
    origin: identity.origin,
    conversationId: identity.conversationId,
    epoch: proof.epoch,
    nextEpoch: proof.nextEpoch,
    unresolved: proof.unresolved,
    outstandingPrepared: proof.outstandingPrepared,
    attestationId: proof.attestationId
  });
}

export function signQuiescence(proof, identity, key) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw Error('PROVIDER_JOURNAL_KEY_INVALID');
  return crypto.createHmac('sha256', key).update(quiescencePayload(proof, identity), 'utf8').digest('hex');
}

export function verifyQuiescence(proof, identity, key) {
  if (!proof || typeof proof.signature !== 'string' || !/^[a-f0-9]{64}$/.test(proof.signature)) return false;
  const expected = Buffer.from(signQuiescence(proof, identity, key), 'hex');
  const supplied = Buffer.from(proof.signature, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
