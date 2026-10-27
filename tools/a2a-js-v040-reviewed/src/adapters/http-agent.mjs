import { NotDispatched } from '../dispatcher.mjs';

/**
 * Generic bridge adapter. The configured endpoint must implement the documented bridge contract in README.
 * A transport failure after fetch starts is ambiguous by design and must never be retried automatically.
 */
export class HttpAgentAdapter {
  constructor({ name, url, token = '', timeoutMs = 120000 }) {
    if (!/^[a-z0-9_-]{1,32}$/.test(name ?? '') || typeof url !== 'string') throw new Error('INVALID_HTTP_ADAPTER_CONFIG');
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('HTTP_ADAPTER_URL_MUST_BE_HTTP');
    if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('REMOTE_ADAPTER_REQUIRES_HTTPS');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('INVALID_TIMEOUT');
    this.name = name; this.url = parsed.toString(); this.token = token; this.timeoutMs = timeoutMs;
  }
  async send(task) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json' };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      // From this point onward, any network/timeout failure is ambiguous. The dispatcher will mark UNKNOWN.
      // Never forward task contents or bearer credentials to a redirect target. A redirect after
      // sending to the configured bridge is still ambiguous, not proof of non-delivery.
      const response = await fetch(this.url, { method: 'POST', redirect: 'error', headers, signal: controller.signal, body: JSON.stringify({
        protocol: 'a2a-bridge-v1', taskId: task.id, contextId: task.contextId,
        parentId: task.parentId, sender: task.sender, recipient: task.recipient, text: task.text,
      }) });
      let body;
      try { body = await response.json(); } catch { throw new Error('BRIDGE_INVALID_JSON_RESPONSE'); }
      if (!response.ok) {
        // A bridge may prove pre-dispatch rejection explicitly; HTTP status alone is not proof.
        if (body?.dispatched === false && body?.accepted === false) throw new NotDispatched('BRIDGE_PROVED_NOT_DISPATCHED');
        throw new Error(`BRIDGE_HTTP_${response.status}`);
      }
      if (body?.accepted !== true || body?.dispatched !== true || typeof body.invocationId !== 'string' || !body.invocationId) throw new Error('BRIDGE_RESPONSE_NOT_ATTESTED');
      if (body.status === 'input_required' && typeof body.question === 'string') return { kind: 'input_required', question: body.question };
      if (body.status !== 'completed' || typeof body.text !== 'string') throw new Error('BRIDGE_RESULT_NOT_COMPLETED');
      return { kind: 'response', text: body.text, invocationId: body.invocationId };
    } finally { clearTimeout(timer); }
  }
}
