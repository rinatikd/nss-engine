import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_ADAPTERS } from '../extension/adapters.js';

const pageSource = readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');

test('Claude selects verified disabled-when-empty send control before legacy aria variants', () => {
  const send = DEFAULT_ADAPTERS.claude.send;
  assert.match(send, /^button\[data-testid="chat-input-send"\]/);
  assert.match(send, /button\[aria-label="Send message"\]/);
  assert.equal(DEFAULT_ADAPTERS.claude.composer.includes('ProseMirror'), true);
});

test('Gemini send selectors use specific buttons only, no generic click targets', () => {
  const send = DEFAULT_ADAPTERS.gemini.send;
  for (const selector of [
    'button.send-button', 'button[aria-label="Send message"]',
    'button[aria-label="Send"]', 'button[mattooltip="Send"]',
    'button[aria-label="Отправить"]', '.send-button-container button'
  ]) assert.ok(send.includes(selector), 'Missing explicit send candidate: '+selector);
  assert.doesNotMatch(send, /(^|,)\s*(?:button|\[role="button"\]|div)(?:\s*,|\s*$)/);
});

test('send requires unique visible enabled button and rechecks origin, conversation and approval', () => {
  assert.match(pageSource, /if \(matches\.length > 1\) throw Error\('Ambiguous send selector; refusing to click'\)/);
  assert.match(pageSource, /if \(matches\.length === 1 && !matches\[0\]\.disabled && matches\[0\]\.getAttribute\('aria-disabled'\) !== 'true'\)/);
  assert.match(pageSource, /if \(!btn\) throw Error\('Unique enabled send button required'\)/);
  assert.match(pageSource, /control\(\);\s*if \(args\.expectedOrigin !== location\.origin/);
  assert.match(pageSource, /args\.expectedConversationId !== conversationId\(\)/);
  assert.match(pageSource, /if \(textOf\(composer\)\) throw Error\('Existing draft: refusing to overwrite'\)/);
});

test('selftest reveals bounded metadata-only send census, never labels, input or prompt', () => {
  assert.match(pageSource, /r\.diagnostics\.sendCandidates = Object\.fromEntries/);
  const section = pageSource.slice(pageSource.indexOf('const sendPatterns ='),pageSource.indexOf('      return r;', pageSource.indexOf('const sendPatterns =')));
  assert.match(section, /\.slice\(0, 8\)/);
  assert.match(section, /nodes\.slice\(0, 3\)\.map\(brief\)/);
  assert.doesNotMatch(section, /innerText|textContent|\.value|aria-label'\)/);
});

test('candidate-only provider adapters remain read-only', () => {
  for (const name of ['grok','qwen','cursor','aistudio']) {
    assert.equal(DEFAULT_ADAPTERS[name].send, '');
    assert.equal(DEFAULT_ADAPTERS[name].stop, '');
  }
});
