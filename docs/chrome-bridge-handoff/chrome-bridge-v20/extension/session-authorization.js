import { CONTROL_ORIGINS } from './permissions.js';
import { eligibleBackgroundControlTabs } from './control-targets.js';
import { permittedTab } from './read-only-dispatch.js';

const STORAGE_KEY = 'bridgeSessionAuthorization';
const ALLOWED_DURATIONS = new Set([60, 180, 240]);
export const SESSION_CAPABILITIES = Object.freeze([
  'agent_send',
  'provider_prepare',
  'provider_commit'
]);

const idPattern = /^[A-Za-z0-9_-]{8,100}$/;
const epochPattern = /^[A-Za-z0-9_-]{16,100}$/;
const inactive = (reason = 'SESSION_AUTH_REQUIRED') => ({
  active: false, reason, sessionId: null, bridgeEpoch: null,
  expiresAt: null, origins: [], capabilities: []
});

export class SessionAuthorization {
  constructor(chromeApi, { now = Date.now } = {}) {
    this.api = chromeApi;
    this.now = now;
  }

  async read() {
    if (!this.api.storage.session?.setAccessLevel)
      throw Error('SECURE_SESSION_STORAGE_REQUIRED');
    await this.api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const { [STORAGE_KEY]: lease = null } = await this.api.storage.session.get(STORAGE_KEY);
    return lease && typeof lease === 'object' && !Array.isArray(lease) ? lease : null;
  }

  async authorize({ sessionId, durationMinutes, origins, bridgeEpoch } = {}) {
    if (!idPattern.test(sessionId || '')) throw Error('SESSION_ID_INVALID');
    if (!ALLOWED_DURATIONS.has(durationMinutes)) throw Error('SESSION_DURATION_INVALID');
    if (!epochPattern.test(bridgeEpoch || '')) throw Error('BRIDGE_EPOCH_INVALID');
    if (!Array.isArray(origins) || !origins.length || origins.length > Object.keys(CONTROL_ORIGINS).length)
      throw Error('SESSION_ORIGINS_INVALID');

    const unique = [...new Set(origins)];
    if (unique.length !== origins.length) throw Error('SESSION_ORIGINS_DUPLICATE');
    for (const origin of unique) {
      if (!Object.hasOwn(CONTROL_ORIGINS, origin)) throw Error('SESSION_ORIGIN_DENIED');
    }
    if (!unique.includes('https://claude.ai')) throw Error('SESSION_CLAUDE_REQUIRED');

    const { sites = {} } = await this.api.storage.local.get('sites');
    const eligible = await eligibleBackgroundControlTabs(this.api, sites, CONTROL_ORIGINS);
    const available = new Set(eligible.map(tab => tab.origin));
    for (const origin of unique) {
      if (sites[origin]?.mode !== 'chat' || sites[origin]?.adapter !== CONTROL_ORIGINS[origin])
        throw Error('SESSION_SITE_NOT_CONFIGURED');
      if (!available.has(origin)) throw Error('SESSION_ORIGIN_NOT_READY');
    }

    const issuedAt = this.now();
    const expiresAt = issuedAt + durationMinutes * 60 * 1000;
    const lease = {
      schemaVersion: 1,
      sessionId,
      bridgeEpoch,
      issuedAt,
      expiresAt,
      origins: unique.sort(),
      capabilities: [...SESSION_CAPABILITIES],
      approvalMode: 'chat-owner-approved',
      status: 'active'
    };
    const previous = await this.read();
    if (previous) {
      const previousStatus = this.publicStatus(previous, bridgeEpoch);
      if (previousStatus.active) throw Error('SESSION_ALREADY_ACTIVE');
      await this.revoke();
    }
    let writeError = null;
    try {
      await this.api.storage.session.set({ [STORAGE_KEY]: lease });
    } catch (error) {
      // Chrome Storage may reject after the write reached the backing store.
      // A rejected promise is therefore UNKNOWN until an exact read-back.
      writeError = error;
    }

    let persisted;
    try {
      persisted = await this.read();
    } catch {
      throw Object.assign(Error('SESSION_PERSISTENCE_UNCONFIRMED'), {
        cause: writeError || undefined
      });
    }
    const persistedKeys=persisted && typeof persisted==='object'
      ? Object.keys(persisted).sort() : [];
    const leaseKeys=Object.keys(lease).sort();
    const exactLease=persistedKeys.length===leaseKeys.length &&
      leaseKeys.every((key,index)=>key===persistedKeys[index] &&
        JSON.stringify(persisted[key])===JSON.stringify(lease[key]));
    if (!exactLease) {
      throw Object.assign(Error('SESSION_PERSISTENCE_UNCONFIRMED'), {
        cause: writeError || undefined
      });
    }

    // Exact read-back is the commit point, including the ambiguous-write case.
    return this.publicStatus(persisted, bridgeEpoch);
  }

  publicStatus(lease, bridgeEpoch) {
    if (!lease) return inactive();
    const allowedOrigins = Object.keys(CONTROL_ORIGINS);
    const leaseOrigins = Array.isArray(lease.origins) ? [...lease.origins] : [];
    const uniqueLeaseOrigins = new Set(leaseOrigins);
    const capabilitiesMatch = Array.isArray(lease.capabilities) &&
      lease.capabilities.length === SESSION_CAPABILITIES.length &&
      SESSION_CAPABILITIES.every(capability => lease.capabilities.includes(capability));
    const originsMatch = leaseOrigins.length >= 1 &&
      leaseOrigins.length <= allowedOrigins.length &&
      uniqueLeaseOrigins.size === leaseOrigins.length &&
      leaseOrigins.includes('https://claude.ai') &&
      leaseOrigins.every(origin => allowedOrigins.includes(origin));
    if (lease.schemaVersion !== 1 || !idPattern.test(lease.sessionId || '') ||
        !epochPattern.test(lease.bridgeEpoch || '') || !Number.isFinite(lease.issuedAt) ||
        !Number.isFinite(lease.expiresAt) || !originsMatch || !capabilitiesMatch ||
        lease.approvalMode !== 'chat-owner-approved' || lease.status !== 'active')
      return inactive('SESSION_STATE_INVALID');
    if (lease.expiresAt <= this.now()) return inactive('SESSION_EXPIRED');
    if (bridgeEpoch !== undefined && bridgeEpoch !== null && lease.bridgeEpoch !== bridgeEpoch)
      return inactive('SESSION_EPOCH_MISMATCH');
    return {
      active: true,
      sessionId: lease.sessionId,
      bridgeEpoch: lease.bridgeEpoch,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      origins: [...lease.origins],
      capabilities: [...lease.capabilities],
      approvalMode: lease.approvalMode
    };
  }

  async status(bridgeEpoch) {
    const lease = await this.read();
    const result = this.publicStatus(lease, bridgeEpoch);
    if (lease && ['SESSION_EXPIRED', 'SESSION_EPOCH_MISMATCH', 'SESSION_STATE_INVALID'].includes(result.reason))
      await this.revoke();
    return result;
  }

  async require({ origin, tabId, command, bridgeEpoch } = {}) {
    const current = await this.status(bridgeEpoch);
    if (!current.active) throw Error(current.reason || 'SESSION_AUTH_REQUIRED');
    if (!current.capabilities.includes(command)) throw Error('SESSION_CAPABILITY_DENIED');
    if (!current.origins.includes(origin) || !Object.hasOwn(CONTROL_ORIGINS, origin))
      throw Error('SESSION_ORIGIN_DENIED');

    const { origin: actualOrigin, site } = await permittedTab(this.api, tabId);
    if (actualOrigin !== origin || site.mode !== 'chat' ||
        site.adapter !== CONTROL_ORIGINS[origin])
      throw Error('SESSION_TAB_BINDING_MISMATCH');
    return current.expiresAt;
  }

  async revoke() {
    if (!this.api.storage.session?.setAccessLevel ||
        typeof this.api.storage.session.remove !== 'function' ||
        typeof this.api.storage.session.get !== 'function')
      throw Error('SECURE_SESSION_STORAGE_REQUIRED');

    await this.api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await this.api.storage.session.remove(STORAGE_KEY);

    // A fulfilled remove() promise is not proof that Chrome persisted the
    // deletion. Re-read the exact key before acknowledging Revoke.
    let snapshot;
    try {
      snapshot = await this.api.storage.session.get(STORAGE_KEY);
    } catch {
      throw Error('SESSION_REVOKE_UNCONFIRMED');
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
        (snapshot[STORAGE_KEY] !== undefined && snapshot[STORAGE_KEY] !== null))
      throw Error('SESSION_REVOKE_UNCONFIRMED');
  }
}
