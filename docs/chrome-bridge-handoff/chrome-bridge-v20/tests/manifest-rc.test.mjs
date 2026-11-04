import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../extension/', import.meta.url);
test('manifest least-privilege deployment guidance disallows permanent all-site capture', () => {
  const docs = readFileSync(new URL('../MANIFEST_CAPTURE_REVIEW.md', import.meta.url), 'utf8');
  assert.match(docs, /activeTab/);
  assert.match(docs, /Do NOT apply this example verbatim/);
  assert.match(docs, /Do not replace the installed manifest/);
  assert.match(docs, /excessively broad/);
});
test('source snapshot has referenced background, control and screenshot sources', () => {
  for (const name of ['background.js', 'control.html', 'control.js', 'permissions.js', 'visual-snapshot.js']) {
    assert.ok(readFileSync(new URL(name, root), 'utf8').length > 40);
  }
});
test('toolbar click records target tab and photo preview remains local', () => {
  const background = readFileSync(new URL('background.js', root), 'utf8');
  const control = readFileSync(new URL('control.js', root), 'utf8');
  assert.match(background, /chrome\.action\.onClicked/);
  assert.match(background, /visualCandidateTabId/);
  assert.match(control, /visualCapture/);
  assert.match(control, /captureLocalTab\(chrome, tabId/);
  const start = control.indexOf("$('visualCapture').onclick");
  const end = control.indexOf("$('visualClear').onclick");
  assert.ok(start >= 0 && end > start);
  const captureSection = control.slice(start, end);
  assert.equal(captureSection.includes("post('/bridge/result'"), false);
});
