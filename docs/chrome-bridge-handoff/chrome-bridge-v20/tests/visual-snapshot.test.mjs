import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageIdentity, captureLocalTab } from '../extension/visual-snapshot.js';
const T = { id: 42, windowId: 8, active: true, url: 'https://claude.ai/chat/test', title: 'CCTV analyze command review' };
const png = 'data:image/png;base64,iVBORw0KGgo=';
const fake = (tab = T, payload = png) => ({
  tabs: {
    get: async () => ({ ...tab }),
    query: async () => [{ ...tab }],
    captureVisibleTab: async () => payload
  }
});
test('identify exact allowlisted provider, refuse lookalike and non-HTTPS', () => {
  assert.equal(pageIdentity(T).provider, 'claude');
  for (const url of ['http://claude.ai/', 'https://claude.ai.evil.example/', 'chrome://settings', 'https://unknown.example/'])
    assert.equal(pageIdentity({ url }).permitted, false);
});
test('snapshot needs explicit local approval and matching active tab', async () => {
  await assert.rejects(captureLocalTab(fake(), 42), /LOCAL_APPROVAL_REQUIRED/);
  await assert.rejects(captureLocalTab(fake(), 42, { approve: async () => false }), /CAPTURE_DENIED_BY_USER/);
  await assert.rejects(captureLocalTab(fake({ ...T, active: false }), 42, { approve: async () => true }), /TARGET_TAB_NOT_ACTIVE/);
  const snapshot = await captureLocalTab(fake(), 42, { approve: async () => true });
  assert.equal(snapshot.provider, 'claude');
  assert.equal(snapshot.transmissionApproved, false);
  assert.equal(snapshot.pngDataUrl, png);
});
test('refuse wrong format and oversized screenshot', async () => {
  await assert.rejects(captureLocalTab(fake(T, 'data:image/jpeg;base64,abcd'), 42, { approve: async () => true }), /UNEXPECTED_CAPTURE_FORMAT/);
  await assert.rejects(captureLocalTab(fake(), 42, { approve: async () => true, maxDataUrlLength: 10 }), /CAPTURE_TOO_LARGE/);
});
test('refuse screenshot when selected tab changes during capture', async () => {
  let changed = false;
  const browser = fake();
  browser.tabs.captureVisibleTab = async () => { changed = true; return png; };
  browser.tabs.get = async () => changed ? { ...T, url: 'https://claude.ai/chat/other' } : { ...T };
  await assert.rejects(captureLocalTab(browser, 42, { approve: async () => true }), /TAB_CHANGED_AFTER_CAPTURE/);
});
test('recognition uses URL/title metadata only; screenshot not auto transmitted', () => {
  const id = pageIdentity({ url: T.url, title: T.title });
  assert.equal(id.title, T.title);
  assert.equal('pngDataUrl' in id, false);
});
