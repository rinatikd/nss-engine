import { ApprovalBroker } from './approval-broker.js';

// Coordinator-owned approval lifecycle. No mutation is executed here.
// A browser panel can be closed/reopened while approvals remain pending.
export class ApprovalSession {
  constructor({ now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    this.now = now;
    // Preserve the global timer receiver in Chromium (instance method calls throw Illegal invocation).
    this.schedule = (...args) => setTimeoutImpl.call(globalThis, ...args);
    this.unschedule = (...args) => clearTimeoutImpl.call(globalThis, ...args);
    this.broker = new ApprovalBroker({ now });
    this.waiters = new Map();
  }
  list() { return this.broker.list(); }
  request(data) {
    let item;
    try {
      item = this.broker.request(data);
    } catch (error) {
      // Do not leak unexpected provider/DOM data across the transport.
      if (/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '')) throw error;
      throw Error('APPROVAL_REGISTRATION_FAILED');
    }
    return new Promise((resolve, reject) => {
      try {
        const delay = Math.max(1, data.expires - this.now());
        const timer = this.schedule(() => {
          this.waiters.delete(item.id);
          this.broker.expire();
          reject(Error('APPROVAL_EXPIRED'));
        }, delay);
        this.waiters.set(item.id, { resolve, reject, timer });
      } catch {
        // Registration already succeeded, but its waiter cannot be started.
        // Remove the orphaned approval so it cannot later be approved.
        this.broker.pending.delete(item.id);
        reject(Error('APPROVAL_SESSION_FAILED'));
      }
    });
  }
  decide({ id, approved, trustedUserGesture }) {
    const waiter = this.waiters.get(id);
    const result = this.broker.decide({ id, approved, trustedUserGesture });
    if (!waiter) throw Error('APPROVAL_WAIT_NOT_FOUND');
    this.unschedule(waiter.timer);
    this.waiters.delete(id);
    if (result.approved) waiter.resolve(result);
    else waiter.reject(Error('USER_DENIED'));
    return { id: result.id, approved: result.approved };
  }
  stop() {
    for (const entry of this.waiters.values()) {
      this.unschedule(entry.timer);
      entry.reject(Error('APPROVAL_CANCELLED'));
    }
    this.waiters.clear();
    this.broker.revokeAll();
  }
}
