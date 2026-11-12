// Lab-only orchestration boundary. No process spawning, no production wiring.
// The caller must inject a tested runner; never accepts a runner from MCP arguments.
import { MAX_JOB_MS } from './temporary-admin-gate.mjs';

export function createLabCodexDispatcher({ gate, runner, audit = () => {}, now = () => Date.now() } = {}) {
  if (!gate || typeof gate.authorizeJob !== 'function' || typeof gate.consumeJob !== 'function' ||
      !runner || typeof runner.run !== 'function' || typeof runner.terminateTree !== 'function') {
    throw Error('LAB_RUNNER_REQUIRED');
  }
  const active = new Map();
  const completed = new Set();
  let cleanupFailed = false;
  const log = (event, requestId) => audit({ at: now(), event, requestId });
  return {
    async submit({ requestId, workspace, prompt, timeoutSec = 120 }) {
      if (typeof requestId !== 'string' || !requestId ||
          typeof workspace !== 'string' || !workspace ||
          typeof prompt !== 'string' || !prompt ||
          !Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec * 1000 > MAX_JOB_MS) {
        throw Error('INVALID_LAB_JOB');
      }
      if (cleanupFailed) throw Error('LAB_RUNNER_CLEANUP_UNCONFIRMED');
      if (active.has(requestId) || completed.has(requestId)) throw Error('DUPLICATE_REQUEST');
      // Reserve before the first await: concurrent submissions cannot race the approval dialog.
      active.set(requestId, { state: 'approving' });
      let timer;
      let cleanupError = null;
      try {
        const grant = await gate.authorizeJob({ requestId, workspace, prompt, timeoutSec });
        if (active.get(requestId)?.cancelled) throw Error('LAB_JOB_CANCELLED');
        gate.consumeJob({ ticket: grant.ticket, requestId, workspace, prompt, timeoutSec });
        const controller = new AbortController();
        const state = { state: 'running', controller };
        active.set(requestId, state);
        timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
        log('started', requestId);
        // Runner contract: it must honor abort and enforce OS-level process-tree termination.
        const result = await runner.run({ requestId, workspace, prompt, timeoutSec, signal: controller.signal });
        if (controller.signal.aborted) throw Error('LAB_JOB_TIMEOUT');
        log('completed', requestId);
        return result;
      } catch (error) {
        log('failed', requestId);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        const state = active.get(requestId);
        if (state?.state === 'running') {
          state.controller.abort();
          // Confirm descendants have stopped before allowing another job.
          try { await runner.terminateTree(requestId); }
          catch (error) {
            cleanupFailed = true;
            cleanupError = Error('LAB_RUNNER_CLEANUP_UNCONFIRMED', { cause: error });
            log('cleanup_unconfirmed', requestId);
          }
        }
        active.delete(requestId);
        completed.add(requestId);
        if (cleanupError) throw cleanupError;
      }
    },
    async cancel(requestId) {
      const state = active.get(requestId);
      if (!state) return false;
      if (state.state === 'approving') {
        // Cannot cancel a local TTY approval prompt, but mark it revoked before it resolves.
        state.cancelled = true;
        log('cancel_requested_during_approval', requestId);
        return true;
      }
      if (state.state !== 'running') return false;
      state.controller.abort();
      try { await runner.terminateTree(requestId); }
      catch { cleanupFailed = true; log('cleanup_unconfirmed', requestId); throw Error('LAB_RUNNER_CLEANUP_UNCONFIRMED'); }
      log('cancelled', requestId);
      return true;
    },
    status() { return { active: active.size, completed: completed.size, cleanupFailed }; },
  };
}
