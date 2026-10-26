import { test } from 'node:test';

// These need a separately built, signed, hash-pinned broker and a disposable VM.
// The current v07 image is a synthetic fixture, not an approved Codex broker.
for (const scenario of [
  'AppContainer token and zero capabilities verified from the host',
  'Job Object limits and kill-on-close verified from the host',
  'protected ACL and reparse/hardlink race denied by Windows',
  'only explicit standard handles and environment variables reach the child',
  'outbound network probe is denied at the OS boundary',
  'synthetic credential and Codex profile access are denied',
  'child process escape is denied and process tree is empty',
  'broker crash closes handles and removes disposable fixture',
]) {
  test(`Windows OS integration: ${scenario}`, { skip: 'BLOCKED: no signed, pinned, production-shaped broker release or approved disposable VM; no OS isolation claim.' }, () => {});
}
