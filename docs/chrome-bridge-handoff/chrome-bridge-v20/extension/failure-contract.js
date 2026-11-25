const STAGES = new Set([
  'VALIDATION','PRECHECK','APPROVAL','REVALIDATION','PAGE_ACTION',
  'TRANSPORT','JOURNAL','OBSERVATION','BRIDGE'
]);
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const MAX_DURATION_MS = 300000;

export function makeFailure(stage, code, startedAt=Date.now(), now=Date.now) {
  const safeStage=STAGES.has(stage)?stage:'BRIDGE';
  const safeCode=typeof code==='string'&&CODE.test(code)?code:safeStage+'_FAILED';
  const elapsed=Number.isFinite(startedAt)?now()-startedAt:0;
  return Object.freeze({
    schemaVersion:1,stage:safeStage,code:safeCode,
    durationMs:Math.max(0,Math.min(MAX_DURATION_MS,Math.round(Number.isFinite(elapsed)?elapsed:0)))
  });
}

export function normalizeFailure(candidate, fallback={}) {
  if(candidate&&candidate.schemaVersion===1&&STAGES.has(candidate.stage)&&
     typeof candidate.code==='string'&&CODE.test(candidate.code)&&
     Number.isSafeInteger(candidate.durationMs)&&candidate.durationMs>=0&&candidate.durationMs<=MAX_DURATION_MS) {
    return {schemaVersion:1,stage:candidate.stage,code:candidate.code,durationMs:candidate.durationMs};
  }
  const stage=STAGES.has(fallback.stage)?fallback.stage:'BRIDGE';
  const code=typeof candidate?.code==='string'&&CODE.test(candidate.code)?candidate.code:
    typeof fallback.code==='string'&&CODE.test(fallback.code)?fallback.code:stage+'_FAILED';
  return makeFailure(stage,code,
    Number.isFinite(fallback.startedAt)?fallback.startedAt:Date.now(),
    typeof fallback.now==='function'?fallback.now:Date.now);
}
