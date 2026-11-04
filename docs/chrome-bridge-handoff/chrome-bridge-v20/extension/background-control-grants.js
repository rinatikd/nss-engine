// Per-tab explicit background Control: session-only, never permanent,
// no implicit grants from reconnect, page read, or transport status.
import { CONTROL_ORIGINS } from './permissions.js';
import { permittedTab } from './read-only-dispatch.js';

const KEY='bridgeBackgroundControlGrants';
export class BackgroundControlGrants {
  constructor(chromeApi,{now=Date.now}={}) {this.api=chromeApi;this.now=now;}
  async read() {
    if (!this.api.storage.session?.setAccessLevel) throw Error('SECURE_SESSION_STORAGE_REQUIRED');
    await this.api.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    const {[KEY]:grants={}}=await this.api.storage.session.get(KEY);
    return grants && typeof grants==='object' && !Array.isArray(grants) ? grants : {};
  }
  async grant({tabId,durationMinutes,localGesture}) {
    if (localGesture!==true) throw Error('LOCAL_GESTURE_REQUIRED');
    if (![15,60].includes(durationMinutes)) throw Error('INVALID_GRANT_DURATION');
    const {origin,site}=await permittedTab(this.api,tabId);
    if (!Object.hasOwn(CONTROL_ORIGINS,origin) ||
        site.mode!=='chat' || site.adapter!==CONTROL_ORIGINS[origin])
      throw Error('CONTROL_ORIGIN_DENIED');
    const expires=this.now()+durationMinutes*60*1000;
    const grants=await this.read();
    grants[String(tabId)]={origin,expires};
    await this.api.storage.session.set({[KEY]:grants});
    return {tabId,origin,expires};
  }
  async require(origin,tabId) {
    const grants=await this.read();
    const entry=grants[String(tabId)];
    if (!entry || entry.origin!==origin || entry.expires<=this.now()) return null;
    return entry.expires;
  }
  async revoke(tabId) {
    const grants=await this.read();
    delete grants[String(tabId)];
    await this.api.storage.session.set({[KEY]:grants});
  }
  async clear() {
    if (!this.api.storage.session?.setAccessLevel) return;
    await this.api.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    await this.api.storage.session.remove(KEY);
  }
}
