// Адаптеры веб-чатов: CSS-селекторы интерфейса. ВНИМАНИЕ: интерфейсы сайтов меняются,
// все значения ниже вЂ” предположения, их нужно откалибровать на своём аккаунте
// (инструмент agent_selftest показывает, сколько элементов находит каждый селектор).
// Свои значения можно задать в окне управления в поле «Адаптеры (JSON)В» вЂ” они накладываются поверх.
//
//   composer вЂ” поле ввода сообщения (textarea или contenteditable)
//   send     вЂ” кнопка отправки
//   stop     вЂ” кнопка «Остановить» (видна, пока ответ генерируется)
//   reply    вЂ” контейнеры ответов ассистента (по одному на ответ; пользовательские сообщения не включать)
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
    send: 'button[data-testid="chat-input-send"], button[aria-label="Send message"], button[aria-label="Send Message"]',
    stop: 'button[aria-label="Stop response"], button[aria-label="Stop Response"]',
    reply: 'div[data-is-streaming], .font-claude-response',
  },
  gemini: {
    label: 'Gemini', origin: 'https://gemini.google.com', newChatUrl: 'https://gemini.google.com/app',
    composer: 'rich-textarea .ql-editor, div.ql-editor[contenteditable="true"]',
    send: 'button.send-button, button[aria-label="Send message"], button[aria-label="Send"], button[mattooltip="Send"], button[mattooltip="Send message"], button[aria-label="Отправить"], button[mattooltip="Отправить"], .send-button-container button',
    stop: 'button.stop, button[aria-label="Stop response"]',
    reply: 'message-content, .model-response-text',
  },
  deepseek: {
    label: 'DeepSeek', origin: 'https://chat.deepseek.com', newChatUrl: 'https://chat.deepseek.com/',
    composer: 'textarea.ds-scroll-area', send: 'div[role="button"].ds-button--primary.ds-button--filled',
    stop: 'button[aria-label="Stop response"]', reply: '.ds-markdown',
  },
  // Equal Control-origin status; provider DOM selectors still require calibration.
  grok: {
    label: 'Grok', origin: 'https://grok.com', newChatUrl: 'https://grok.com/',
    composer: 'textarea, [contenteditable="true"][role="textbox"]',
    send: '', stop: '', reply: '',
  },
  // Cursor web Cloud Agents, not the local Cursor IDE. The page may contain
  // task launch controls rather than a standard conversation; diagnose first.
  cursor: {
    label: 'Cursor Cloud Agents (candidate)', origin: 'https://cursor.com',
    newChatUrl: 'https://cursor.com/agents',
    composer: 'textarea, [contenteditable="true"][role="textbox"]',
    send: '', stop: '', reply: '',
  },
  qwen: {
    label: 'Qwen', origin: 'https://chat.qwen.ai', newChatUrl: 'https://chat.qwen.ai/',
    composer: 'textarea, [contenteditable="true"][role="textbox"]',
    send: '', stop: '', reply: '',
  },
  kimi: {
    label: 'Kimi', origin: 'https://www.kimi.ai', newChatUrl: 'https://www.kimi.ai/',
    composer: 'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]',
    send: '', stop: '', reply: '',
  },
  aistudio: {
    label: 'Google AI Studio (candidate)', origin: 'https://aistudio.google.com', newChatUrl: 'https://aistudio.google.com/',
    composer: 'textarea, [contenteditable="true"][role="textbox"]',
    send: '', stop: '', reply: '',
  },
  generic: {
    label: 'Другой чат (селекторы вручную)', origin: '', newChatUrl: '',
    composer: '', send: '', stop: '', reply: '',
  },
};

export function mergeAdapters(overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_ADAPTERS)) out[k] = { ...v, ...(overrides[k] || {}) };
  for (const [k, v] of Object.entries(overrides)) if (!out[k]) out[k] = { label: k, origin: '', newChatUrl: '', composer: '', send: '', stop: '', reply: '', ...v };
  return out;
}

