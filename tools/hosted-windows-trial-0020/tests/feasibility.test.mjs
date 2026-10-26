import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = new URL('../', import.meta.url);
const matrix = await readFile(new URL('FEASIBILITY.md', base), 'utf8');
const workflow = await readFile(new URL('.github/workflows/source-only.yml', base), 'utf8');
let inspector = '';
for (const candidate of ['../windows-broker-v10/native/image_inspector.cpp', '../chrome-bridge-windows-broker-v10/native/image_inspector.cpp']) {
  inspector = await readFile(new URL(candidate, base), 'utf8').catch(() => '');
  if (inspector) break;
}

test('feasibility matrix accounts for all eight requested probes and keeps them blocked', () => {
  for (const topic of ['AppContainer', 'Job limits', 'DACL', 'Inherited handles and environment', 'Network denial', 'Synthetic credential', 'Child-process escape', 'Crash cleanup']) {
    assert.ok(matrix.includes(topic), `missing matrix entry: ${topic}`);
  }
  assert.match(matrix, /SKIP\/BLOCKED: all eight probes/);
});

test('workflow is manually triggered only and cannot build or execute a binary', () => {
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
  assert.match(workflow, /node --test/);
  assert.doesNotMatch(workflow, /\b(cl\.exe|image_inspector\.exe|broker\.exe|worker\.exe|CreateProcessW|ResumeThread)\b/i);
  assert.match(workflow, /persist-credentials:\s*false/);
});

test('current v0.10 source has no process-launch code and remains diagnostic only when present', () => {
  if (!inspector) return assert.ok(matrix.includes('The design is not implemented in this package'));
  assert.doesNotMatch(inspector, /\b(CreateProcess|ShellExecute|WinExec|ResumeThread)\w*/);
  assert.match(inspector, /executionAuthorized.*false/);
});
