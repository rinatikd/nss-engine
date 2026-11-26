import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const pilotPath = new URL('../pilot/launch.mjs', import.meta.url);
const pilot = (await import(pilotPath.href).catch(() => null));
const pilotUnavailable = pilot ? false : 'Pilot launcher is not shipped; direct Codex execution remains disabled pending attested OS isolation.';

test('pilot rejects implicit workspace, remote options and shell shims', { skip: pilotUnavailable }, () => {
  const { parse } = pilot;
  for (const args of [[], ['--remote'], ['--workspace', '.'], ['--run', '--run']])
    assert.throws(() => parse(args));
});

test('preview never spawns; local execution preserves stdin, exit and evidence', { skip: pilotUnavailable }, () => {
  const { parse, launch } = pilot;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pilot-'));
  try {
    const exe = path.join(dir, 'codex.exe'); fs.writeFileSync(exe, 'fixture');
    const args = ['--workspace', dir, '--executable', exe, '--logs', dir, '--prompt', 'Review only; $() & are text'];
    const options = parse(args);
    const preview = launch(options, () => { throw Error('must not spawn'); });
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.bridgeExecution, false);
    assert.equal(preview.providerNetworkMayBeUsed, false);
    assert.throws(() => parse([...args, '--workspace', dir]));
    fs.writeFileSync(path.join(dir, 'codex.cmd'), 'fixture');
    assert.throws(() => parse(args.map(x => x === exe ? path.join(dir, 'codex.cmd') : x)));
    for (const status of [0, 7, null]) {
      let spawnConfig;
      const result = launch({ ...options, run: true }, (file, cli, config) => {
        spawnConfig = { file, cli, config };
        return { status, stdout: '{"type":"turn.completed"}\n', stderr: 'fixture error',
          ...(status === null ? { error: { code: 'ETIMEDOUT' } } : {}) };
      });
      assert.equal(spawnConfig.file, exe); assert.equal(spawnConfig.config.shell, false);
      assert.equal(spawnConfig.config.input, options.prompt); assert.equal(spawnConfig.config.env.CODEX_HOME, undefined);
      assert.ok(spawnConfig.cli.includes('read-only')); assert.ok(!spawnConfig.cli.includes('--remote'));
      assert.equal(result.bridgeExecution, false);
      assert.equal(result.providerNetworkMayBeUsed, true);
      assert.equal(result.launcherExitCode, status ?? 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, 'result.json'))).exitCode, status);
      assert.match(fs.readFileSync(path.join(result.directory, 'stdout.jsonl'), 'utf8'), /turn.completed/);
      assert.equal(fs.readFileSync(path.join(result.directory, 'stderr.log'), 'utf8'), 'fixture error');
      if (status === null) assert.equal(result.status, 'termination_unconfirmed');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

