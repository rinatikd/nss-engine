export const CONTROL_ORIGINS = Object.freeze({
  'https://claude.ai': 'claude',
  'https://gemini.google.com': 'gemini',
  'https://chat.deepseek.com': 'deepseek',
});
export const CONTROL_ACTIONS = new Set(['browser_open', 'browser_click', 'browser_fill', 'agent_send', 'agent_new_chat']);
export const CONTROL_DURATION_MS = Object.freeze({ 60: 60 * 60 * 1000, 180: 180 * 60 * 1000, 240: 240 * 60 * 1000 });
export class ControlGrants {
  constructor(now = Date.now) { this.now = now; this.grants = new Map(); this.epoch = null; }
  reset(epoch = null) { this.grants.clear(); this.epoch = epoch; }
  approve(origin, trusted, durationMinutes = 240) {
    if (!trusted || !this.epoch || !CONTROL_ORIGINS[origin]) throw Error('Local approval on an allowed origin required');
    if (!Object.hasOwn(CONTROL_DURATION_MS, durationMinutes)) throw Error('Invalid control duration');
    this.grants.set(origin, this.now() + CONTROL_DURATION_MS[durationMinutes]);
  }
  require(origin) {
    const expires = this.grants.get(origin);
    if (!CONTROL_ORIGINS[origin] || !this.epoch || !expires || expires <= this.now()) {
      this.grants.delete(origin);
      throw Error('Control denied: explicit local re-grant required');
    }
    return expires;
  }
}
