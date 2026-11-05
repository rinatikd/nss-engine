// Browser transport independent of a UI document. No Chrome UI or permission
// APIs here: the host owns command execution and approval requirements.
// This module is intentionally NOT activated by the old control.html poller.
// A single owner must be selected during the migration; two pollers can steal
// each other's commands and violate delivery/approval semantics.
const DEFAULT_ENDPOINT = 'http://127.0.0.1:17381';
export class BridgeTransport {
  constructor({ fetchImpl = fetch, execute, onStatus = () => {},
    sleepImpl = ms => new Promise(r => setTimeout(r, ms)), endpoint = DEFAULT_ENDPOINT }) {
    if (typeof execute !== 'function') throw Error('COMMAND_EXECUTOR_REQUIRED');
    // Never invoke native fetch as a BridgeTransport method: in Chromium
    // workers, native fetch requires its original global receiver.
    // The closure preserves injected fetchImpl for unit tests.
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.execute = execute;
    this.onStatus = onStatus;
    this.sleep = sleepImpl;
    this.endpoint = endpoint;
    this.active = false;
    this.generation = 0;
    this.abort = null;
    this.token = null;
    this.lastStatus = { state: 'disconnected', connected: false, error: null };
  }
  status(state, error = null) {
    this.lastStatus = { state, connected: state === 'connected', error };
    this.onStatus({ ...this.lastStatus });
  }
  async post(path, body, abort, timeout = 27000) {
    const limit = AbortSignal.timeout(timeout);
    const signal = AbortSignal.any([abort.signal, limit]);
    let response;
    try {
      response = await this.fetchImpl(this.endpoint + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.token
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      // Preserve the public error code while exposing the *safe* root cause
      // in the dedicated transport worker DevTools console. No tokens,
      // headers, body or original exception message may enter diagnostics.
      console.warn('[Chrome Bridge transport network]', {
        endpoint: this.endpoint,
        operation: path,
        errorName: String(error?.name || 'Unknown').slice(0, 60),
        timeout: limit.aborted === true,
        manuallyStopped: abort.signal.aborted === true
      });
      if (abort.signal.aborted) throw Error('POLL_STOPPED');
      if (limit.aborted) throw Error('BRIDGE_TIMEOUT');
      throw Error('BRIDGE_NETWORK_UNREACHABLE');
    }
    if (response.status === 401) throw Error('BROWSER_KEY_REJECTED_401');
    if (response.status === 403) throw Error('EXTENSION_ORIGIN_REJECTED_403');
    if (!response.ok) throw Error('BRIDGE_HTTP_' + response.status);
    return response.json();
  }
  async start(token) {
    if (this.active) return false;
    if (typeof token !== 'string' || !token.trim()) throw Error('KEY_EMPTY');
    this.token = token.trim();
    this.active = true;
    const gen = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.status('connecting');
    void this.run(gen, abort);
    return true;
  }
  stop() {
    this.active = false;
    ++this.generation;
    this.abort?.abort();
    this.abort = null;
    this.token = null;
    this.status('disconnected');
  }
  async run(gen, abort) {
    let consecutive = 0;
    while (this.active && gen === this.generation) {
      try {
        const poll = await this.post('/bridge/poll', {}, abort);
        if (!this.active || gen !== this.generation) break;
        if (!poll || !poll.epoch) throw Error('BRIDGE_INVALID_HANDSHAKE');
        consecutive = 0;
        this.status('connected');
        if (poll.command) {
          const cmd = poll.command;
          let result, error;
          if (!Number.isFinite(cmd.expires) || Date.now() >= cmd.expires) {
            error = 'Command expired';
          } else {
            try { result = await this.execute(cmd); }
            catch (e) { error = e?.message || 'Command failed'; }
          }
          // A non-idempotent command is never re-executed just because a result
          // acknowledgement was lost. The server must handle UNKNOWN outcomes.
          if (!this.active || gen !== this.generation) break;
          try {
            await this.post('/bridge/result', { id: cmd.id, result, error }, abort, 10000);
          } catch (e) {
            this.status('recovering', 'RESULT_ACK_UNKNOWN');
            // Do not repeat the command or the result after an uncertain ACK.
          }
        }
      } catch (e) {
        if (!this.active || gen !== this.generation || abort.signal.aborted) break;
        const reason = e?.message || 'UNKNOWN';
        if (reason === 'BROWSER_KEY_REJECTED_401' || reason === 'EXTENSION_ORIGIN_REJECTED_403') {
          this.active = false;
          this.token = null;
          this.status('auth-failed', reason);
          break;
        }
        this.status('recovering', reason);
        consecutive = Math.min(consecutive + 1, 6);
        await this.sleep(Math.min(30000, 750 * (2 ** consecutive)));
      }
    }
  }
}
