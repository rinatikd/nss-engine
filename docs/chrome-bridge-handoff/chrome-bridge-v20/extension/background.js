// Р—РЅР°С‡РѕРє СЂР°СЃС€РёСЂРµРЅРёСЏ РѕС‚РєСЂС‹РІР°РµС‚ (РёР»Рё С„РѕРєСѓСЃРёСЂСѓРµС‚) РІРєР»Р°РґРєСѓ СѓРїСЂР°РІР»РµРЅРёСЏ.
chrome.action.onClicked.addListener(async (clickedTab) => {
  // This toolbar click is the user invocation that can grant activeTab.
  // Only remember the clicked tab's numeric ID; never store its page content.
  if (clickedTab?.id && clickedTab?.url?.startsWith('https://')) {
    await chrome.storage.session.set({ visualCandidateTabId: clickedTab.id });
  }
  const url = chrome.runtime.getURL('control.html');
  const existing = (await chrome.tabs.query({})).find((t) => t.url === url);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
});

