import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const windowsOnly = process.platform === 'win32' ? false : 'Requires native Windows filesystem semantics';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source candidate Кириллица-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const kit = path.join(dir, 'build kit Исходники');
  const output = path.join(dir, 'candidate Кандидат');
  const baseline = path.join(kit, 'baseline-source');
  const overlay = path.join(kit, 'overlay');
  fs.mkdirSync(baseline, {recursive: true});
  fs.mkdirSync(overlay);
  fs.copyFileSync(new URL('./build-source-candidate.mjs', import.meta.url), path.join(kit, 'build-source-candidate.mjs'));
  fs.writeFileSync(path.join(baseline, 'server.mjs'), 'original server');
  fs.writeFileSync(path.join(baseline, 'unchanged.txt'), Buffer.from([0, 255, 128, 13, 10]));
  fs.writeFileSync(path.join(overlay, 'server.mjs'), 'updated server');
  fs.mkdirSync(path.join(overlay, 'данные с пробелами'));
  const added = Buffer.concat([Buffer.from('Новый файл\r\n'), Buffer.from([0, 255])]);
  fs.writeFileSync(path.join(overlay, 'данные с пробелами', 'файл.bin'), added);
  const sourceManifest = {schemaVersion: 1, baselineFiles: {'server.mjs': hash('original server'), 'unchanged.txt': hash(Buffer.from([0, 255, 128, 13, 10]))}};
  const updateManifest = {schemaVersion: 1, version: 'fixture', updatedFiles: {'server.mjs': hash('updated server'), 'данные с пробелами/файл.bin': hash(added)}};
  const writeManifests = () => {
    fs.writeFileSync(path.join(kit, 'source-manifest.json'), JSON.stringify(sourceManifest));
    fs.writeFileSync(path.join(kit, 'update-manifest.json'), JSON.stringify(updateManifest));
  };
  writeManifests();
  const run = (target = output) => {
    const result = spawnSync(process.execPath, [path.join(kit, 'build-source-candidate.mjs'), '--output', target], {encoding: 'utf8'});
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  };
  return {dir, kit, output, baseline, overlay, sourceManifest, updateManifest, added, writeManifests, run};
}

function refused(f, reason, output = f.output) {
  const result = f.run(output);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, reason);
  return result;
}

function createLink(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Windows cannot create ${type} link (${error.code}); requires symlink support/privilege`);
      return false;
    }
    throw error;
  }
}

test('builds exact source-only bytes with Unicode/spaces and no original archive', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.output, 'server.mjs'), 'utf8'), 'updated server');
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'unchanged.txt')), fs.readFileSync(path.join(f.baseline, 'unchanged.txt')));
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'данные с пробелами', 'файл.bin')), f.added);
  assert.equal(hash(fs.readFileSync(path.join(f.output, 'данные с пробелами', 'файл.bin'))), f.updateManifest.updatedFiles['данные с пробелами/файл.bin']);
  assert.equal(fs.readFileSync(path.join(f.baseline, 'server.mjs'), 'utf8'), 'original server');
  const ready = JSON.parse(fs.readFileSync(path.join(f.output, 'CANDIDATE_READY.json')));
  assert.equal(ready.SOURCE_ONLY_CANDIDATE, true);
  assert.equal(ready.verified, true);
  assert.equal(ready.files, 3);
  assert.equal(ready.nativeWindowsVerified, false);
  assert.equal(ready.liveWebsitesVerified, false);
  assert.equal(Object.hasOwn(ready, 'originalArchiveSha256'), false);
  assert.equal(JSON.parse(result.stdout).SOURCE_ONLY_CANDIDATE, true);
});

test('does not copy unlisted private state or historical reports from either source tree', t => {
  const f = fixture(t);
  for (const root of [f.kit, f.baseline, f.overlay]) {
    fs.writeFileSync(path.join(root, '.env'), 'SYNTHETIC_SECRET=not-a-real-secret');
    fs.mkdirSync(path.join(root, 'reports'));
    fs.writeFileSync(path.join(root, 'reports', 'private-history.json'), '{"syntheticPrivateState":true}');
  }
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(f.output).sort(), ['CANDIDATE_READY.json', 'server.mjs', 'unchanged.txt', 'данные с пробелами']);
  for (const root of [f.kit, f.baseline, f.overlay]) assert.equal(fs.existsSync(path.join(root, '.env')), true);
});

for (const tree of ['baseline', 'overlay']) {
  test(`tampered ${tree} is refused before any output is created`, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f[tree], 'server.mjs'), 'tampered');
    refused(f, tree === 'baseline' ? /BASELINE_INTEGRITY_FAILURE/ : /UPDATE_INTEGRITY_FAILURE/);
    assert.equal(fs.existsSync(f.output), false);
  });
}

for (const kind of ['directory', 'file']) {
  test(`existing output ${kind} is preserved`, t => {
    const f = fixture(t);
    const bytes = Buffer.from([255, 0, 128]);
    if (kind === 'directory') fs.mkdirSync(f.output);
    const sentinel = kind === 'directory' ? path.join(f.output, 'server.mjs') : f.output;
    fs.writeFileSync(sentinel, bytes);
    refused(f, /OUTPUT_ALREADY_EXISTS/);
    assert.deepEqual(fs.readFileSync(sentinel), bytes);
    if (kind === 'directory') assert.deepEqual(fs.readdirSync(f.output), ['server.mjs']);
  });
}

test('rerun preserves a completed candidate and its marker', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const ready = fs.readFileSync(path.join(f.output, 'CANDIDATE_READY.json'));
  refused(f, /OUTPUT_ALREADY_EXISTS/);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'CANDIDATE_READY.json')), ready);
});

for (const outputLocation of ['inside kit', 'kit parent']) {
  test(`output ${outputLocation} is refused`, t => {
    const f = fixture(t);
    const output = outputLocation === 'inside kit' ? path.join(f.kit, 'new output') : f.dir;
    refused(f, /OUTPUT_MUST_BE_SEPARATE/, output);
    assert.equal(fs.existsSync(path.join(f.kit, 'new output')), false);
    assert.equal(fs.readFileSync(path.join(f.baseline, 'server.mjs'), 'utf8'), 'original server');
  });
}

for (const name of ['../escape', 'C:/escape', 'folder\\escape', 'CANDIDATE_READY.json', 'server.mjs/child', 'SERVER.MJS']) {
  test(`invalid/colliding manifest path ${name} is refused before output`, t => {
    const f = fixture(t);
    f.updateManifest.updatedFiles[name] = hash('updated server');
    // Supply files when possible so collision tests exercise the merged output tree.
    if (name === 'CANDIDATE_READY.json' || name === 'SERVER.MJS') fs.writeFileSync(path.join(f.overlay, name), 'updated server');
    if (name === 'server.mjs/child') {
      delete f.updateManifest.updatedFiles['server.mjs'];
      fs.unlinkSync(path.join(f.overlay, 'server.mjs'));
      fs.mkdirSync(path.join(f.overlay, 'server.mjs'));
      fs.writeFileSync(path.join(f.overlay, 'server.mjs', 'child'), 'updated server');
    }
    f.writeManifests();
    refused(f, /INVALID_MANIFEST_(PATH|COLLISION)/);
    assert.equal(fs.existsSync(f.output), false);
  });
}

test('baseline file link is refused before output', t => {
  const f = fixture(t);
  const target = path.join(f.kit, 'linked target.mjs');
  fs.renameSync(path.join(f.baseline, 'server.mjs'), target);
  if (!createLink(t, target, path.join(f.baseline, 'server.mjs'), 'file')) return;
  refused(f, /SOURCE_LINK_NOT_ALLOWED/);
  assert.equal(fs.existsSync(f.output), false);
});

test('linked baseline root is refused before output', t => {
  const f = fixture(t);
  const target = path.join(f.kit, 'real baseline');
  fs.renameSync(f.baseline, target);
  if (!createLink(t, target, f.baseline, 'dir')) return;
  refused(f, /SOURCE_LINK_NOT_ALLOWED/);
  assert.equal(fs.existsSync(f.output), false);
});

test('linked output ancestor is refused before output', t => {
  const f = fixture(t);
  const link = path.join(f.dir, 'linked parent');
  if (!createLink(t, f.dir, link, 'dir')) return;
  refused(f, /SOURCE_LINK_NOT_ALLOWED/, path.join(link, path.basename(f.output)));
  assert.equal(fs.existsSync(f.output), false);
});

test('Windows output ancestor junction is refused', {skip: windowsOnly}, t => {
  const f = fixture(t);
  const link = path.join(f.dir, 'junction parent');
  if (!createLink(t, f.dir, link, 'junction')) return;
  refused(f, /SOURCE_LINK_NOT_ALLOWED/, path.join(link, path.basename(f.output)));
  assert.equal(fs.existsSync(f.output), false);
});

test('Windows case-insensitive kit containment is refused', {skip: windowsOnly}, t => {
  const f = fixture(t);
  const alias = path.join(f.dir, path.basename(f.kit).toUpperCase());
  assert.equal(fs.realpathSync(alias).toLowerCase(), fs.realpathSync(f.kit).toLowerCase());
  const output = path.join(alias, 'new output');
  refused(f, /OUTPUT_MUST_BE_SEPARATE/, output);
  assert.equal(fs.existsSync(output), false);
});
