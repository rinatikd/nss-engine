import { SelectedReadTabs } from './selected-read-tabs.js';

// Listener deliberately installed in the MV3 service worker: read grants must
// not survive a navigation away-and-back or closed/reused tab identifier.
export function installReadGrantRevocation(chromeApi) {
  const revoke = tabId => {
    // Do not disclose URLs, prompts or tokens in diagnostic logging.
    void new SelectedReadTabs(chromeApi).revoke(tabId).catch(() => {});
  };
  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (typeof changeInfo?.url === 'string') revoke(tabId);
  });
  chromeApi.tabs.onRemoved.addListener(revoke);
}
