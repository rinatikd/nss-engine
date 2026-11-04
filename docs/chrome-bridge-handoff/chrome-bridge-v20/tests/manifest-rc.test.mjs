import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.rc.example.json', root), 'utf8'));
test('MV3 screenshot example uses activeTab, not permanent universal host access', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  assert.ok(!manifest.host_permissions.includes('https://*/*'));
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
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
  assert.doesNotMatch(control.slice(control.indexOf("'visualCapture').onclick") , /post\('\/bridge\/result'/);
});
