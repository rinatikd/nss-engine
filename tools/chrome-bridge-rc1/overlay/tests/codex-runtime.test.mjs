import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCodexJobs } from '../server/codex-runtime.mjs';

function fixture(t, root = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(root, 'bridge-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'evaluated');
  const policy = path.join(dir, 'policy.mjs');
  fs.writeFileSync(policy, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'unsafe'); throw Error('EVALUATED');`);
  return { dir, marker, policy };
}

async function assertClosedAtObservedPath(t, candidate, marker) {
  const resolved = path.resolve(candidate);
  // Establish that a canonical-name discrepancy, rather than a real symlink,
  // determines which fail-closed gate this ordinary fixture reaches.
  let ancestor = resolved;
  while (true) {
    assert.equal(fs.lstatSync(ancestor).isSymbolicLink(), false, ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  assert.equal(fs.statSync(resolved).isFile(), true);
  const canonical = fs.realpathSync.native(resolved);
  const samePath = process.platform === 'win32'
    ? canonical.toLowerCase() === resolved.toLowerCase()
    : canonical === resolved;
  const expected = samePath ? 'CODEX_ISOLATION_UNAVAILABLE' : 'POLICY_LINK_DENIED';
  t.diagnostic(JSON.stringify({ resolved, canonical, samePath, expected }));
  await assert.rejects(loadCodexJobs(candidate), error => {
    assert.equal(error.message, expected);
    return true;
  });
  assert.equal(fs.existsSync(marker), false);
}

test('invalid policy locations fail before evaluation', async () => {
  for (const candidate of [undefined, null, {}, '', 'relative.mjs', '\\\\server\\share\\policy.mjs', '\\\\?\\C:\\policy.mjs', 'C:\\policy.mjs:stream', 'bad\0path']) {
    await assert.rejects(loadCodexJobs(candidate), /INVALID_POLICY_MODULE/);
  }
});

for (const [label, root] of [['agent workspace', process.cwd()], ['writable temporary directory', os.tmpdir()]]) {
  test(`${label} policy cannot execute top-level side effects`, async t => {
    const f = fixture(t, root);
    await assertClosedAtObservedPath(t, f.policy, f.marker);
  });
}

test('missing files and directories are rejected with sanitized errors', async t => {
  const f = fixture(t);
  for (const p of [f.dir, path.join(f.dir, 'missing.mjs')]) await assert.rejects(loadCodexJobs(p), /^Error: INVALID_POLICY_MODULE$/);
});

for (const kind of ['file', 'parent']) test(`real ${kind} symlink attack is rejected before evaluation`, async t => {
  const f = fixture(t);
  const link = path.join(f.dir, 'alias');
  try { fs.symlinkSync(kind === 'file' ? f.policy : f.dir, link, kind === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`OS refused test link creation: ${e.code}`); throw e; }
  await assert.rejects(loadCodexJobs(kind === 'file' ? link : path.join(link, 'policy.mjs')), /POLICY_LINK_DENIED/);
  assert.equal(fs.existsSync(f.marker), false);
});

test('hard-link alias cannot bypass the closed trust gate', async t => {
  const f = fixture(t);
  const alias = path.join(f.dir, 'hardlink.mjs');
  fs.linkSync(f.policy, alias);
  assert.equal(fs.statSync(f.policy).ino, fs.statSync(alias).ino);
  assert.equal(fs.statSync(f.policy).nlink, 2);
  await assertClosedAtObservedPath(t, alias, f.marker);
});

for (const attack of ['unauthorized file read', 'unauthorized file write', 'synthetic credential read', 'network connection', 'descendant process escape']) {
  test(`Windows OS confinement: ${attack}`, { skip: 'No verified OS runner deployed; fail-closed loader is tested separately. No OS-denial claim.' }, () => {});
}

test('all Codex MCP tools remain discoverable and closed by default', async t => {
  const { createBridge } = await import('../server/bridge.mjs');
  const server = createBridge({ agentToken: 'synthetic-agent', browserToken: 'synthetic-browser' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const rpc = async (method, params) => (await (await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-agent', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json());
  const list = await rpc('tools/list');
  assert.deepEqual(list.result.tools.filter(x => x.name.startsWith('browser_')).map(x => x.name).sort(),
    ['browser_status', 'browser_tabs', 'browser_open', 'browser_read', 'browser_wait', 'browser_click', 'browser_fill'].sort());
  const jobId = '00000000-0000-4000-8000-000000000000';
  for (const [name, args] of [
    ['codex_submit', { requestId: 'closed', workspace: 'source', prompt: 'synthetic test only' }],
    ['codex_job', { jobId }], ['codex_cancel', { jobId }],
  ]) {
    assert.ok(list.result.tools.some(x => x.name === name));
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /CODEX_DISABLED/);
  }
});
