import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('server entry point reports missing configuration when its path contains spaces', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a path with spaces '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(fileURLToPath(new URL('../src/', import.meta.url)), path.join(dir, 'src'), { recursive: true });
  const env = { ...process.env };
  delete env.A2A_DB;
  delete env.A2A_API_TOKEN;
  const result = spawnSync(process.execPath, [path.join(dir, 'src', 'server.mjs')], { env, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Set A2A_DB/);
});
