// Шаблоны очевидных секретов. Это ограничивающий фильтр, а не гарантия.
export const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['API key (sk-)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Bearer token', /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}/i],
];
export function findSecret(text) {
  for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) return label;
  return null;
}
