import { ApprovalBroker } from './approval-broker.js';

// Coordinator-owned approval lifecycle. No mutation is executed here.
// A browser panel can be closed/reopened while approvals remain pending.
export class ApprovalSession {
  constructor({ now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    this.now = now;
    this.schedule = setTimeoutImpl;
    this.unschedule = clearTimeoutImpl;
    this.broker = new ApprovalBroker({ now });
    this.waiters = new Map();
  }
  list() { return this.broker.list(); }
  request(data) {
    const item = this.broker.request(data);
    return new Promise((resolve, reject) => {
      const delay = Math.max(1, data.expires - this.now());
      const timer = this.schedule(() => {
        this.waiters.delete(item.id);
        this.broker.expire();
        reject(Error('APPROVAL_EXPIRED'));
      }, delay);
      this.waiters.set(item.id, { resolve, reject, timer });
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
