const STAGES = new Set([
  'VALIDATION','PRECHECK','APPROVAL','REVALIDATION','PAGE_ACTION',
  'TRANSPORT','JOURNAL','OBSERVATION','BRIDGE'
]);
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const MAX_DURATION_MS = 300000;
const PROVIDER_SIDE_EFFECTS = new Set([
  'none','composer-cleared','composer-draft-may-remain','composer-filled-no-send',
  'composer-draft-state-unverified','send-click-may-have-fired','send-click-receipt-unpersisted'
]);
export function normalizeProviderSideEffect(value) {
  return PROVIDER_SIDE_EFFECTS.has(value) ? value : null;
}

export function safeFailureCode(value, fallback='BRIDGE_FAILURE') {
  if (typeof value === 'string' && CODE.test(value)) return value;
  const message = typeof value === 'string' ? value : value?.message;
  if (/expired after dispatch/i.test(message || '')) return 'COMMAND_TIMEOUT_AFTER_DISPATCH';
  if (/previous request is still pending/i.test(message || '')) return 'PREVIOUS_REQUEST_PENDING';
  if (/expired/i.test(message || '')) return 'COMMAND_EXPIRED';
  if (/disconnect/i.test(message || '')) return 'CHROME_DISCONNECTED';
  if (/timeout/i.test(message || '')) return 'COMMAND_TIMEOUT';
  return CODE.test(fallback) ? fallback : 'BRIDGE_FAILURE';
}

export function makeFailure(stage, code, startedAt=Date.now(), now=Date.now) {
  const safeStage = STAGES.has(stage) ? stage : 'BRIDGE';
  const safeCode = safeFailureCode(code, safeStage+'_FAILED');
  const elapsed = Number.isFinite(startedAt) ? now()-startedAt : 0;
  return Object.freeze({
    schemaVersion:1,stage:safeStage,code:safeCode,
    durationMs:Math.max(0,Math.min(MAX_DURATION_MS,Math.round(Number.isFinite(elapsed)?elapsed:0)))
  });
}

export function normalizeFailure(candidate, fallback={}) {
  if (candidate && candidate.schemaVersion===1 && STAGES.has(candidate.stage) &&
      typeof candidate.code==='string' && CODE.test(candidate.code) &&
      Number.isSafeInteger(candidate.durationMs) && candidate.durationMs>=0 &&
      candidate.durationMs<=MAX_DURATION_MS) {
    return {schemaVersion:1,stage:candidate.stage,code:candidate.code,durationMs:candidate.durationMs};
  }
  const stage=STAGES.has(fallback.stage)?fallback.stage:'BRIDGE';
  const code=safeFailureCode(fallback.code,stage+'_FAILED');
  return makeFailure(stage,code,
    Number.isFinite(fallback.startedAt)?fallback.startedAt:Date.now(),
    typeof fallback.now==='function'?fallback.now:Date.now);
}
