// Deny content-script access to persisted credentials as soon as MV3 starts.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch(() => { /* control.js refuses persistence when this is unavailable */ });
// Open the control surface in its own window so a user-invoked capture can
// inspect the still-active source tab in the original Chrome window.
// This operation runs only after a local toolbar click, never on polling.
chrome.action.onClicked.addListener(async (clickedTab) => {
  if (clickedTab?.id && clickedTab?.url?.startsWith('https://')) {
    await chrome.storage.session.set({ visualCandidateTabId: clickedTab.id });
  }
  const url = chrome.runtime.getURL('control.html');
  const existing = (await chrome.tabs.query({})).find((tab) => tab.url === url);
  if (existing) {
    // Reuse an already open control page without moving tabs between windows.
    // If the control page is in the same window, capturing requires opening
    // it in a separate window manually. Never switch the target tab silently.
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.windows.create({ url, type: 'popup', focused: true, width: 750, height: 850 });
});
