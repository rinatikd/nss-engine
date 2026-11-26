// Local-only screenshot primitive for VISUAL-DEBUG-01.
// This module DOES NOT send a screenshot to MCP or any external service.
// The caller must have an active user-approved capture capability and
// obtain separate approval before viewing or transmitting pixel data.
const SAFE_ORIGINS = new Set([
  'https://claude.ai', 'https://gemini.google.com', 'https://chat.deepseek.com',
  'https://github.com', 'https://chat.qwen.ai', 'https://grok.com'
]);
function safeOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && SAFE_ORIGINS.has(u.origin) ? u.origin : null;
  } catch { return null; }
}
export function pageIdentity({ url, title = '' }) {
  const origin = safeOrigin(url);
  if (!origin) return { permitted: false, provider: 'unknown', evidence: 'origin-not-allowlisted' };
  const providers = {
    'https://claude.ai': 'claude',
    'https://gemini.google.com': 'gemini',
    'https://chat.deepseek.com': 'deepseek',
    'https://github.com': 'github',
    'https://chat.qwen.ai': 'qwen',
    'https://grok.com': 'grok'
  };
  return { permitted: true, provider: providers[origin], origin, title: String(title).slice(0, 160) };
}
export async function captureLocalTab(chromeApi, tabId, { approve, maxDataUrlLength = 3_000_000 } = {}) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw Error('INVALID_TAB_ID');
  if (typeof approve !== 'function') throw Error('LOCAL_APPROVAL_REQUIRED');
  const before = await chromeApi.tabs.get(tabId);
  const identity = pageIdentity(before);
  if (!identity.permitted) throw Error('CAPTURE_ORIGIN_DENIED');
  if (!before.active) throw Error('TARGET_TAB_NOT_ACTIVE');
  const confirmed = await approve({ tabId, origin: identity.origin, title: identity.title });
  if (confirmed !== true) throw Error('CAPTURE_DENIED_BY_USER');
  const activeBefore = (await chromeApi.tabs.query({ active: true, windowId: before.windowId }))[0];
  if (activeBefore?.id !== tabId || activeBefore?.url !== before.url) throw Error('TAB_CHANGED_BEFORE_CAPTURE');
  // Chrome requires an appropriate extension permission for captureVisibleTab.
  // Do not silently request broader host permissions or switch user tabs.
  const png = await chromeApi.tabs.captureVisibleTab(before.windowId, { format: 'png' });
  if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) throw Error('UNEXPECTED_CAPTURE_FORMAT');
  if (png.length > maxDataUrlLength) throw Error('CAPTURE_TOO_LARGE');
  const after = await chromeApi.tabs.get(tabId);
  const activeAfter = (await chromeApi.tabs.query({ active: true, windowId: before.windowId }))[0];
  if (after.url !== before.url || !after.active || activeAfter?.id !== tabId) throw Error('TAB_CHANGED_AFTER_CAPTURE');
  return {
    tabId, capturedAt: new Date().toISOString(),
    provider: identity.provider, url: before.url, title: identity.title,
    pngDataUrl: png, // SENSITIVE: local only, never log or auto-send
    transmissionApproved: false
  };
}
