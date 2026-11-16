// OpenAgents event -> bounded PowerShell Direct engineering request.
// No direct execution, no implicit approval, no credentials in events.
import { createHash } from 'node:crypto';

export const OPERATIONS = Object.freeze(new Set([
  'git-status','git-diff','git-log','git-branch','git-diff-check',
  'node-test','dotnet-build','dotnet-test'
]));
export const AGENTS = Object.freeze(new Set(['codex','claude','gemini','deepseek','kimi','qwen']));
const ID = /^[a-zA-Z0-9_-]{8,80}$/;
export function translateOpenAgentsTask(event, {allowedRoots = [], authorizedTaskIds = []} = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('INVALID_EVENT');
  const {taskId, agent, operation, workspace, approvalState, target} = event;
  if (typeof taskId !== 'string' || !ID.test(taskId)) throw new Error('INVALID_TASK_ID');
  if (!AGENTS.has(agent)) throw new Error('UNSUPPORTED_AGENT');
  if (!OPERATIONS.has(operation)) throw new Error('UNSUPPORTED_OPERATION');
  // The sender cannot grant itself approval: authorization must come from a trusted local registry.\n  if (approvalState !== 'approved' || !authorizedTaskIds.includes(taskId)) throw new Error('APPROVAL_REQUIRED');
  if (typeof workspace !== 'string' || !allowedRoots.includes(workspace)) throw new Error('WORKSPACE_NOT_ALLOWED');
  if (target !== undefined && (typeof target !== 'string' || target.length > 300 || /[\r\n\0]/.test(target))) throw new Error('INVALID_TARGET');
  const requestId = 'oa_' + createHash('sha256').update(taskId).digest('hex').slice(0,32);
  return Object.freeze({requestId, operation, workspace, ...(target === undefined ? {} : {target})});
}
// In-memory idempotency for one process. Durable deduplication must be enforced by executor.
export class DispatchGate {
  #seen = new Set();
  constructor(submit, config) {
    if (typeof submit !== 'function') throw new TypeError('submit must be a function');
    this.submit = submit; this.config = config;
  }
  async dispatch(event) {
    const request = translateOpenAgentsTask(event, this.config);
    if (this.#seen.has(request.requestId)) return {state:'duplicate', requestId:request.requestId};
    this.#seen.add(request.requestId);
    try {
      const result = await this.submit(request);
      return {state:'submitted', requestId:request.requestId, result};
    } catch (error) {
      // Do not retry unknown dispatch outcomes automatically.
      return {state:'unknown', requestId:request.requestId, errorCode:'SUBMISSION_UNCONFIRMED'};
    }
  }
}
