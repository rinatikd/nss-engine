// Копия server/secrets.mjs с флагом g для редактирования (ограничивающий фильтр, не гарантия).
export const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['API key (sk-)', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['Bearer token', /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}/gi],
  ['token in URL', /([?&](?:access_token|token|api_key|apikey|key|secret|password|sig|signature)=)[^&\s#]{8,}/gi],
];
export function findSecret(text) {
  for (const [label, re] of SECRET_PATTERNS) { re.lastIndex = 0; if (re.test(text)) { re.lastIndex = 0; return label; } }
  return null;
}
export function redact(text) {
  let out = String(text ?? '');
  for (const [label, re] of SECRET_PATTERNS) out = out.replace(re, (m, p1) => (label === 'token in URL' ? p1 : '') + '[REDACTED]');
  return out;
}
