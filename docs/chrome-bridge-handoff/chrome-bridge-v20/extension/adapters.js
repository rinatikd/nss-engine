// РђРґР°РїС‚РµСЂС‹ РІРµР±-С‡Р°С‚РѕРІ: CSS-СЃРµР»РµРєС‚РѕСЂС‹ РёРЅС‚РµСЂС„РµР№СЃР°. Р’РќРРњРђРќРР•: РёРЅС‚РµСЂС„РµР№СЃС‹ СЃР°Р№С‚РѕРІ РјРµРЅСЏСЋС‚СЃСЏ,
// РІСЃРµ Р·РЅР°С‡РµРЅРёСЏ РЅРёР¶Рµ вЂ” РїСЂРµРґРїРѕР»РѕР¶РµРЅРёСЏ, РёС… РЅСѓР¶РЅРѕ РѕС‚РєР°Р»РёР±СЂРѕРІР°С‚СЊ РЅР° СЃРІРѕС‘Рј Р°РєРєР°СѓРЅС‚Рµ
// (РёРЅСЃС‚СЂСѓРјРµРЅС‚ agent_selftest РїРѕРєР°Р·С‹РІР°РµС‚, СЃРєРѕР»СЊРєРѕ СЌР»РµРјРµРЅС‚РѕРІ РЅР°С…РѕРґРёС‚ РєР°Р¶РґС‹Р№ СЃРµР»РµРєС‚РѕСЂ).
// РЎРІРѕРё Р·РЅР°С‡РµРЅРёСЏ РјРѕР¶РЅРѕ Р·Р°РґР°С‚СЊ РІ РѕРєРЅРµ СѓРїСЂР°РІР»РµРЅРёСЏ РІ РїРѕР»Рµ В«РђРґР°РїС‚РµСЂС‹ (JSON)В» вЂ” РѕРЅРё РЅР°РєР»Р°РґС‹РІР°СЋС‚СЃСЏ РїРѕРІРµСЂС….
//
//   composer вЂ” РїРѕР»Рµ РІРІРѕРґР° СЃРѕРѕР±С‰РµРЅРёСЏ (textarea РёР»Рё contenteditable)
//   send     вЂ” РєРЅРѕРїРєР° РѕС‚РїСЂР°РІРєРё
//   stop     вЂ” РєРЅРѕРїРєР° В«РћСЃС‚Р°РЅРѕРІРёС‚СЊВ» (РІРёРґРЅР°, РїРѕРєР° РѕС‚РІРµС‚ РіРµРЅРµСЂРёСЂСѓРµС‚СЃСЏ)
//   reply    вЂ” РєРѕРЅС‚РµР№РЅРµСЂС‹ РѕС‚РІРµС‚РѕРІ Р°СЃСЃРёСЃС‚РµРЅС‚Р° (РїРѕ РѕРґРЅРѕРјСѓ РЅР° РѕС‚РІРµС‚; РїРѕР»СЊР·РѕРІР°С‚РµР»СЊСЃРєРёРµ СЃРѕРѕР±С‰РµРЅРёСЏ РЅРµ РІРєР»СЋС‡Р°С‚СЊ)
export const DEFAULT_ADAPTERS = {
  chatgpt: {
    label: 'ChatGPT', origin: 'https://chatgpt.com', newChatUrl: 'https://chatgpt.com/',
    composer: '#prompt-textarea',
    send: 'button[data-testid="send-button"]',
    stop: 'button[data-testid="stop-button"]',
    reply: '[data-message-author-role="assistant"]',
  },
  claude: {
    label: 'Claude', origin: 'https://claude.ai', newChatUrl: 'https://claude.ai/new',
    composer: 'div[contenteditable="true"].ProseMirror, div[contenteditable="true"][role="textbox"]',
    send: 'button[aria-label="Send message"], button[aria-label="Send Message"]',
    stop: 'button[aria-label="Stop response"], button[aria-label="Stop Response"]',
    reply: 'div[data-is-streaming], .font-claude-response',
  },
  gemini: {
    label: 'Gemini', origin: 'https://gemini.google.com', newChatUrl: 'https://gemini.google.com/app',
    composer: 'rich-textarea .ql-editor, div.ql-editor[contenteditable="true"]',
    send: 'button.send-button, button[aria-label="Send message"]',
    stop: 'button.stop, button[aria-label="Stop response"]',
    reply: 'message-content, .model-response-text',
  },
  deepseek: {
    label: 'DeepSeek', origin: 'https://chat.deepseek.com', newChatUrl: 'https://chat.deepseek.com/',
    composer: 'textarea.ds-scroll-area', send: 'div[role="button"].ds-button--primary.ds-button--filled',
    stop: 'button[aria-label="Stop response"]', reply: '.ds-markdown',
  },
  // Candidate-only adapters: no new CONTROL_ORIGINS are granted by this package.
  // Their CSS selectors require live calibration before enabling write operations.
  grok: {
    label: 'Grok (candidate)', origin: 'https://grok.com', newChatUrl: 'https://grok.com/',
    composer: 'textarea, [contenteditable="true"][role="textbox"]',
    send: '', stop: '', reply: '',
  },
  qwen: {
    label: 'Qwen (candidate)', origin: 'https://chat.qwen.ai', newChatUrl: 'https://chat.qwen.ai/',
    composer: 'textarea, [contenteditable="true"][role="textbox"]',
    send: '', stop: '', reply: '',
  },
  aistudio: {
    label: 'Google AI Studio (candidate)', origin: 'https://aistudio.google.com', newChatUrl: 'https://aistudio.google.com/',
    composer: 'textarea, [contenteditable="true"][role="textbox"]',
    send: '', stop: '', reply: '',
  },
  generic: {
    label: 'Р”СЂСѓРіРѕР№ С‡Р°С‚ (СЃРµР»РµРєС‚РѕСЂС‹ РІСЂСѓС‡РЅСѓСЋ)', origin: '', newChatUrl: '',
    composer: '', send: '', stop: '', reply: '',
  },
};

export function mergeAdapters(overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_ADAPTERS)) out[k] = { ...v, ...(overrides[k] || {}) };
  for (const [k, v] of Object.entries(overrides)) if (!out[k]) out[k] = { label: k, origin: '', newChatUrl: '', composer: '', send: '', stop: '', reply: '', ...v };
  return out;
}

