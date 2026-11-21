import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlGrants, CONTROL_ORIGINS, DISCOVERY_ONLY_ORIGINS, providerForOrigin, CONTROL_DURATION_MS } from '../extension/permissions.js';
import { DEFAULT_ADAPTERS } from '../extension/adapters.js';
import { pageAction } from '../extension/page.js';
import { toolByName } from '../server/tools.mjs';
test('tool descriptions match the preserved Control allowlist and durations', () => {
 assert.deepEqual(Object.keys(CONTROL_ORIGINS).sort(), ['https://chat.deepseek.com', 'https://claude.ai', 'https://gemini.google.com']);
 const description = toolByName('agent_send').description;
 for (const origin of Object.keys(CONTROL_ORIGINS)) assert.ok(description.includes(origin));
 assert.match(description, /explicit local approval \(1, 3 or 4 hours\)/);
 assert.doesNotMatch(description, /chatgpt\.com|grok\.com|chat\.qwen\.ai/);
});
test('control requires local approval, exact allowed origin and a live epoch; expires and resets', () => {
 let now = 100; const g = new ControlGrants(() => now);
 for (const origin of Object.keys(CONTROL_ORIGINS)) {
  assert.throws(() => g.require(origin)); assert.throws(() => g.approve(origin, true));
  g.reset('instance'); assert.throws(() => g.approve(origin, false));
  g.approve(origin, true); assert.equal(g.require(origin), now + CONTROL_DURATION_MS[240]);
  now += CONTROL_DURATION_MS[240]; assert.throws(() => g.require(origin));
  g.approve(origin, true); g.reset('restart'); assert.throws(() => g.require(origin));
  g.reset();
 }
 g.reset('instance');
 for (const o of ['https://chatgpt.com','https://claude.ai.evil.test','http://claude.ai','https://example.com']) {
  assert.throws(() => g.approve(o,true)); assert.throws(() => g.require(o));
 }
});
test('each allowed origin has its own complete adapter', () => {
 for (const [origin, key] of Object.entries(CONTROL_ORIGINS)) {
  const a = DEFAULT_ADAPTERS[key]; assert.equal(a.origin, origin);
  assert.equal(new URL(a.newChatUrl).origin, origin);
  for (const k of ['composer','send','reply','stop']) assert.ok(a[k]);
 }
});
test('Grok, Qwen, Cursor remain outside the Control allowlist even if diagnostic selectors exist', () => {
 for (const [key, origin] of [['grok','https://grok.com'], ['qwen','https://chat.qwen.ai'], ['cursor','https://cursor.com']]) {
  const adapter = DEFAULT_ADAPTERS[key];
  assert.equal(adapter.origin, origin);
  assert.equal(Object.hasOwn(CONTROL_ORIGINS, origin), false);
  if (key === 'grok') assert.equal(adapter.send, 'button[data-testid="chat-submit"]');
  assert.equal(providerForOrigin(origin), null);
  assert.equal(adapter.stop, '');
  assert.equal(adapter.reply, '');
  const grants = new ControlGrants(() => 100);
  grants.reset('test-instance');
  assert.throws(() => grants.approve(origin, true), /allowed origin/);
  assert.throws(() => grants.require(origin), /Control denied/);
 }
});
test('injected mutation denies other origins and expired grants before DOM access', async () => {
 globalThis.location = { origin:'https://example.com' };
 assert.match((await pageAction('agent_send',{controlExpires:Date.now()+1000},location.origin)).error,/Control denied/);
 location.origin = 'https://claude.ai';
 assert.match((await pageAction('browser_click',{controlExpires:0},location.origin)).error,/Control denied/);
 delete globalThis.location;
});


test('global off is denied even with per-origin grant; explicit revoke removes only selected origin', () => {
  const g = new ControlGrants(() => 1000);
  g.reset('session');
  g.approve('https://claude.ai', true, 60);
  g.approve('https://gemini.google.com', true, 60);
  assert.equal(g.status('https://claude.ai', false).allowed, false);
  assert.equal(g.status('https://claude.ai', true).allowed, true);
  g.revoke('https://claude.ai');
  assert.equal(g.status('https://claude.ai', true).allowed, false);
  assert.throws(() => g.require('https://claude.ai'));
  assert.equal(g.status('https://gemini.google.com', true).allowed, true);
  g.revoke('https://claude.ai');
  g.reset();
  assert.equal(g.status('https://gemini.google.com', true).allowed, false);
});

test('candidate origins are exact and cannot be escalated through lookalike hosts', () => {
 for (const value of ['https://grok.com.evil.test', 'http://cursor.com', 'https://chat.qwen.ai.evil.test'])
   assert.equal(providerForOrigin(new URL(value).origin), null);
 for (const origin of Object.keys(DISCOVERY_ONLY_ORIGINS))
   assert.equal(new ControlGrants().status(origin, true).allowed, false);
});
