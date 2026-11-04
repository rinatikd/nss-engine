import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolByName } from '../server/tools.mjs';
const controller = readFileSync(new URL('../extension/control.js', import.meta.url), 'utf8');
test('control status is read-only and cannot expose the browser token', () => {
  const tool = toolByName('control_status');
  assert.equal(tool.kind, 'ext');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.required, []);
  const section = controller.slice(controller.indexOf("if (name === 'control_status')"), controller.indexOf("if (name === 'browser_tabs')"));
  assert.match(section, /approvalPending/);
  assert.match(section, /globalEnabled/);
  assert.match(section, /grants\.status\(/);
  assert.doesNotMatch(section, /browserToken|\$\('token'\)|args\.text/);
});
test('agent send requires explicit approval before injection', () => {
  const section = controller.slice(controller.indexOf("if (['agent_send', 'agent_peek'"), controller.indexOf("throw Error('Unknown command: '", controller.indexOf("if (['agent_send', 'agent_peek'")));
  assert.match(section, /await askApproval\('Отправить AI-запрос'/);
  assert.match(section, /grants\.require\(site\.origin\)/);
  assert.match(section, /Conversation changed before approval/);
  assert.match(section, /AI tab changed after approval/);
  assert.ok(section.indexOf('await askApproval') < section.lastIndexOf('return result'));
});
test('open and new-chat must request local approval', () => {
  assert.match(controller, /await askApproval\('Открыть вкладку'/);
  assert.match(controller, /await askApproval\('Новый AI-чат'/);
  assert.match(controller, /Command stopped or expired/);
});
