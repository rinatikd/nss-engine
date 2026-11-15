// Pure, non-executing readiness preflight for AI chat adapters.
// This module DOES NOT grant Chrome origins, type text, click controls,
// authenticate users, or send messages. Integration requires separate review.
export const PROVIDER_ORIGINS = Object.freeze({
  grok: Object.freeze(['https://grok.com']),
  claude: Object.freeze(['https://claude.ai']),
  gemini: Object.freeze(['https://gemini.google.com']),
  kimi: Object.freeze(['https://www.kimi.ai', 'https://kimi.ai']),
  deepseek: Object.freeze(['https://chat.deepseek.com'])
});
const providerNames = Object.keys(PROVIDER_ORIGINS);
export function checkProviderOrigin(provider, url) {
  if(!providerNames.includes(provider)) return false;
  try {
    const parsed = new URL(url);
    if(parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    // Explicit exact-origin match prevents suffix tricks (e.g. kimi.ai.evil.test).
    return PROVIDER_ORIGINS[provider].includes(parsed.origin);
  } catch { return false; }
}
export function classifyProviderPreflight(input = {}) {
  const {provider, url, authState='unknown', originGranted=false,
    composerVisible=false, composerTextLength=0,
    sendVisible=false, sendEnabled=false} = input;
  if(!checkProviderOrigin(provider,url))
    return {state:'UNSUPPORTED_ORIGIN',canSend:false};
  if(authState==='login_required')
    return {state:'GOOGLE_SIGN_IN_OPERATOR_REQUIRED',canSend:false};
  if(authState!=='authenticated')
    return {state:'AUTH_STATE_NOT_VERIFIED',canSend:false};
  if(originGranted!==true)
    return {state:'SITE_CONTROL_GRANT_REQUIRED',canSend:false};
  if(composerVisible!==true)
    return {state:'COMPOSER_NOT_READY',canSend:false};
  if(!Number.isInteger(composerTextLength) || composerTextLength<0)
    return {state:'INVALID_COMPOSER_LENGTH',canSend:false};
  // A missing Send button with zero text is expected on many providers.
  // Prefill is a separately approved local action and must NOT submit.
  if(composerTextLength===0)
    return {state:'NEEDS_APPROVED_UNSENT_PREFILL',canSend:false};
  if(sendVisible!==true)
    return {state:'SEND_NOT_VISIBLE_AFTER_TYPING',canSend:false};
  if(sendEnabled!==true)
    return {state:'SEND_NOT_ENABLED_AFTER_TYPING',canSend:false};
  // READY is an observation, NOT authorization or a confirmed dispatch.
  return {state:'READY_FOR_SEPARATELY_APPROVED_SEND',canSend:false};
}
