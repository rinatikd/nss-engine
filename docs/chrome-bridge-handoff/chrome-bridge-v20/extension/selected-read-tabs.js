// Explicit, short-lived READ enrollment of an exact browser tab and URL.
// Intended for main-profile Chrome. Never inferred from origin permission,
// network connectivity, installed extension, or previously saved agent IDs.
const KEY = 'bridgeSelectedReadTabs';
export const READ_GRANT_MINUTES = 60;

export class SelectedReadTabs {
  constructor(chromeApi, { now = Date.now } = {}) {
    this.api = chromeApi;
    this.now = now;
  }
  async all() {
    if (!this.api.storage.session?.setAccessLevel) throw Error('SECURE_SESSION_STORAGE_REQUIRED');
    await this.api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const stored = (await this.api.storage.session.get(KEY))[KEY];
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }
  async grant({ tabId, expectedUrl, localGesture }) {
    if (localGesture !== true) throw Error('LOCAL_GESTURE_REQUIRED');
    if (!Number.isSafeInteger(tabId) || tabId <= 0) throw Error('INVALID_TAB_ID');
    const tab = await this.api.tabs.get(tabId);
    if (!tab?.url || tab.url !== expectedUrl) throw Error('TAB_CHANGED_BEFORE_GRANT');
    const origin = new URL(tab.url).origin;
    if (!tab.url.startsWith('https://')) throw Error('HTTPS_REQUIRED');
    const { sites = {} } = await this.api.storage.local.get('sites');
    if (!Object.hasOwn(sites, origin) || sites[origin]?.selectedTabOnly !== true)
      throw Error('SCOPED_SITE_REQUIRED');
    if (!(await this.api.permissions.contains({ origins: [origin + '/*'] })))
      throw Error('HOST_PERMISSION_MISSING');
    const grants = await this.all();
    const expires = this.now() + READ_GRANT_MINUTES * 60000;
    grants[String(tabId)] = { origin, url: tab.url, expires };
    await this.api.storage.session.set({ [KEY]: grants });
    return { tabId, origin, expires };
  }
  async require(tabId, tabUrl) {
    const entries = await this.all();
    const entry = entries[String(tabId)];
    if (!entry || !Number.isFinite(entry.expires) || entry.expires <= this.now() ||
        entry.url !== tabUrl || entry.origin !== new URL(tabUrl).origin)
      throw Error('EXPLICIT_TAB_READ_GRANT_REQUIRED');
    return entry.expires;
  }
  async revoke(tabId) {
    const entries = await this.all();
    delete entries[String(tabId)];
    await this.api.storage.session.set({ [KEY]: entries });
  }
  async revokeOrigin(origin) {
    const entries = await this.all();
    for (const [id, entry] of Object.entries(entries)) {
      if (entry?.origin === origin) delete entries[id];
    }
    await this.api.storage.session.set({ [KEY]: entries });
  }
  async clear() {
    if (!this.api.storage.session?.setAccessLevel) return;
    await this.api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await this.api.storage.session.remove(KEY);
  }
}
