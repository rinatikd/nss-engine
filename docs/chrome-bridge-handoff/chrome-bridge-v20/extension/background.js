// Р—РЅР°С‡РѕРє СЂР°СЃС€РёСЂРµРЅРёСЏ РѕС‚РєСЂС‹РІР°РµС‚ (РёР»Рё С„РѕРєСѓСЃРёСЂСѓРµС‚) РІРєР»Р°РґРєСѓ СѓРїСЂР°РІР»РµРЅРёСЏ.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('control.html');
  const existing = (await chrome.tabs.query({})).find((t) => t.url === url);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
});

