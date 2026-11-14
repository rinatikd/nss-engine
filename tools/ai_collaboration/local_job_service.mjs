// Service-side bridge for an explicitly approved, named local test suite.
// The connected MCP host must implement approveRequest using a genuine local
// host approval channel. A model-supplied "approved:true" never authorizes work.
// Jobs are at-most-once: a crash or lost ACK becomes UNKNOWN, never a re-run.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveTestPlan, executeTestPlan, TaskPolicyError } from './local_test_runner.mjs';

const ID = /^[a-zA-Z0-9_-]{8,80}$/;
const safeOutput = value => String(value ?? '')
  .replace(/(Bearer\s+)[a-zA-Z0-9._-]+/gi, '$1[REDACTED]')
  .replace(/((?:api[_-]?key|browserToken|agentToken|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
    '$1[REDACTED]')
  .slice(0, 65536);
const fingerprint = plan => createHash('sha256')
  .update(JSON.stringify([plan.suite, plan.cwd, plan.command, plan.args, plan.timeoutMs]))
  .digest('hex');

export function createLocalJobService({
  approvedWorkspaceRoots,
  auditDirectory,
  approveRequest,
  runner = executeTestPlan
}) {
  if (!Array.isArray(approvedWorkspaceRoots) || !approvedWorkspaceRoots.length)
    throw new TaskPolicyError('WORKSPACE_POLICY_MISSING');
  if (typeof approveRequest !== 'function')
    throw new TaskPolicyError('LOCAL_APPROVAL_HANDLER_MISSING');
  if (!path.isAbsolute(auditDirectory))
    throw new TaskPolicyError('AUDIT_DIR_NOT_ABSOLUTE');
  let activeRequestId = null;
  const auditPath = requestId => path.join(auditDirectory, requestId + '.json');
  const read = async requestId => {
    if (!ID.test(requestId || '')) throw new TaskPolicyError('INVALID_REQUEST_ID');
    try { return JSON.parse(await readFile(auditPath(requestId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {requestId,state:'NOT_FOUND'}; throw error; }
  };
  return {
    status: read,
    async submit({requestId,suite,workspace}) {
      if (!ID.test(requestId || '')) throw new TaskPolicyError('INVALID_REQUEST_ID');
      // Claim the request before asking for approval or executing.
      await mkdir(auditDirectory, {recursive:true,mode:0o700});
      let claim;
      try { claim = await open(auditPath(requestId), 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST')
          return {requestId,state:'UNKNOWN_PREVIOUS_REQUEST',note:'Inspect existing job; never auto-retry'};
        throw error;
      }
      let plan;
      try {
        // The "approved" fields below are solely internal compatibility values;
        // the genuine decision MUST come from the host-owned approveRequest hook.
        plan = await resolveTestPlan({
          requestId,suite,workspace,approved:true,approvedRequestId:requestId
        }, approvedWorkspaceRoots);
        const digest = fingerprint(plan);
        await claim.writeFile(JSON.stringify({requestId,suite,state:'PENDING_LOCAL_APPROVAL',
          planSha256:digest,createdAt:new Date().toISOString()}));
        await claim.sync();
        await claim.close();
        claim=null;
        // A local approval must bind the exact requestId AND hashed immutable plan.
        const approved = await approveRequest({requestId,suite,workspace:plan.cwd,
          planSha256:digest,operation:'execute-named-suite'});
        if (approved?.approved !== true ||
            approved?.requestId !== requestId ||
            approved?.planSha256 !== digest) {
          await writeFile(auditPath(requestId),JSON.stringify({
            requestId,suite,state:'DENIED',planSha256:digest
          }));
          return {requestId,state:'DENIED'};
        }
        if (activeRequestId !== null) {
          await writeFile(auditPath(requestId),JSON.stringify({
            requestId,suite,state:'DENIED',reason:'ANOTHER_JOB_RUNNING',planSha256:digest
          }));
          return {requestId,state:'DENIED',reason:'ANOTHER_JOB_RUNNING'};
        }
        activeRequestId = requestId;
        await writeFile(auditPath(requestId),JSON.stringify({
          requestId,suite,state:'RUNNING',planSha256:digest,startedAt:new Date().toISOString()
        }));
        const result = await runner(plan);
        const final = {requestId,suite,planSha256:digest,
          state:result.timedOut===true ? 'TIMED_OUT' : 'FINISHED',
          exitCode:result.exitCode,signal:result.signal || null,
          timedOut:result.timedOut===true,
          terminationUnconfirmed:result.terminationUnconfirmed===true,
          stdout:safeOutput(result.stdout),stderr:safeOutput(result.stderr),
          truncated:result.truncated===true,endedAt:new Date().toISOString()};
        await writeFile(auditPath(requestId),JSON.stringify(final));
        return final;
      } catch(error) {
        if (claim) { await claim.close().catch(()=>{}); }
        // Preserve an UNKNOWN record rather than risking duplicate execution.
        const state={requestId,suite,state:'UNKNOWN_OR_FAILED',
          errorCode:error instanceof TaskPolicyError ? error.message:'JOB_FAILED'};
        await writeFile(auditPath(requestId),JSON.stringify(state));
        return state;
      } finally {
        if (activeRequestId === requestId) activeRequestId = null;
      }
    }
  };
}
