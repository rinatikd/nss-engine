// Pure selection of already approved Control targets. No host-permission prompts,
// wildcard grants or implicit website onboarding occur in this function.
export async function eligibleBackgroundControlTabs(chromeApi,sites,controlOrigins) {
  const tabs=await chromeApi.tabs.query({});
  const candidates=[];
  for (const tab of tabs) {
    if (!Number.isSafeInteger(tab.id) || !tab.url) continue;
    let origin;
    try { origin=new URL(tab.url).origin; } catch { continue; }
    const site=sites[origin];
    if (!Object.hasOwn(controlOrigins,origin) || !site || site.mode!=='chat' ||
        site.adapter!==controlOrigins[origin]) continue;
    if (!await chromeApi.permissions.contains({origins:[origin+'/*']})) continue;
    candidates.push({id:tab.id,origin});
  }
  return candidates;
}
