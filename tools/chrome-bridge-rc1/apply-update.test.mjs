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
  // Exercise argument handling without a shell, including kit/source/output names.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge update Кириллица-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const kit = path.join(dir, 'update kit Обновление');
  const source = path.join(dir, 'source Исходник');
  const output = path.join(dir, 'candidate Кандидат');
  fs.mkdirSync(kit);
  fs.mkdirSync(source);
  fs.mkdirSync(path.join(kit, 'overlay'));
  fs.copyFileSync(new URL('./apply-update.mjs', import.meta.url), path.join(kit, 'apply-update.mjs'));
  fs.writeFileSync(path.join(source, 'original.txt'), 'original');
  fs.writeFileSync(path.join(source, 'private-config.json'), 'synthetic-local-private-state');
  fs.writeFileSync(path.join(kit, 'overlay', 'original.txt'), 'updated');
  const manifest = {
    schemaVersion: 1, version: 'test', originalArchiveSha256: hash('archive'),
    originalFiles: {'original.txt': hash('original')},
    updatedFiles: {'original.txt': hash('updated')},
  };
  const writeManifest = () => fs.writeFileSync(path.join(kit, 'update-manifest.json'), JSON.stringify(manifest));
  writeManifest();
  const run = (options = {}) => {
    const result = spawnSync(process.execPath, [path.join(kit, 'apply-update.mjs'),
      '--source', options.source ?? source, '--output', options.output ?? output], {encoding: 'utf8'});
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  };
  return {dir, kit, source, output, manifest, writeManifest, run};
}

function refused(result, reason) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, reason);
}

function createLink(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    // Windows file/directory symlinks may require Developer Mode or SeCreateSymbolicLinkPrivilege.
    // Unexpected errors still fail; Linux failures are never treated as privilege skips.
    if (process.platform === 'win32' && ['EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Windows cannot create ${type} link in this environment (${error.code}); requires symlink support/privilege`);
      return false;
    }
    throw error;
  }
}

test('updater handles spaces/Cyrillic paths and preserves original/private files', t => {
  const f = fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(f.output, 'original.txt'), 'utf8'), 'updated');
  assert.equal(fs.readFileSync(path.join(f.source, 'original.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(f.source, 'private-config.json'), 'utf8'), 'synthetic-local-private-state');
  assert.deepEqual(fs.readdirSync(f.output).sort(), ['CANDIDATE_READY.json', 'original.txt']);
  const ready = JSON.parse(fs.readFileSync(path.join(f.output, 'CANDIDATE_READY.json')));
  assert.equal(ready.verified, true);
  assert.equal(ready.files, 1);
  assert.equal(ready.originalArchiveSha256, hash('archive'));
  assert.equal(JSON.parse(r.stdout).originalUnchanged, true);
  const marker = fs.readFileSync(path.join(f.output, 'CANDIDATE_READY.json'));
  refused(f.run(), /OUTPUT_ALREADY_EXISTS/);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'CANDIDATE_READY.json')), marker);
});

test('copies exact binary/UTF-8 bytes and hashes baseline plus overlay files', t => {
  const f = fixture(t);
  const name = 'данные с пробелами/байты.bin';
  const original = Buffer.from([0, 255, 13, 10, 128, 0]);
  const updated = Buffer.concat([Buffer.from('Обновление\r\n', 'utf8'), Buffer.from([0, 254, 255])]);
  for (const root of [f.source, path.join(f.kit, 'overlay')]) fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true});
  fs.writeFileSync(path.join(f.source, name), original);
  fs.writeFileSync(path.join(f.kit, 'overlay', name), updated);
  const unchanged = Buffer.from('unchanged\r\nКириллица\n', 'utf8');
  fs.writeFileSync(path.join(f.source, 'unchanged.txt'), unchanged);
  f.manifest.originalFiles[name] = hash(original);
  f.manifest.originalFiles['unchanged.txt'] = hash(unchanged);
  f.manifest.updatedFiles[name] = hash(updated);
  f.writeManifest();
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(path.join(f.output, name)), updated);
  assert.equal(hash(fs.readFileSync(path.join(f.output, name))), f.manifest.updatedFiles[name]);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'unchanged.txt')), unchanged);
  assert.deepEqual(fs.readFileSync(path.join(f.source, name)), original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.output, 'CANDIDATE_READY.json'))).files, 3);
});

test('wrong baseline creates no output even when overlay replaces that file', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'original.txt'), 'changed');
  refused(f.run(), /ORIGINAL_SOURCE_MISMATCH/);
  assert.equal(fs.existsSync(f.output), false);
  assert.equal(fs.readFileSync(path.join(f.source, 'original.txt'), 'utf8'), 'changed');
});

test('tampered overlay creates no output', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.kit, 'overlay', 'original.txt'), 'tampered');
  refused(f.run(), /UPDATE_INTEGRITY_FAILURE/);
  assert.equal(fs.existsSync(f.output), false);
});

test('manifest traversal creates no output', t => {
  const f = fixture(t);
  f.manifest.originalFiles = {'../escape': hash('bad')};
  f.writeManifest();
  refused(f.run(), /INVALID_MANIFEST_PATH/);
  assert.equal(fs.existsSync(f.output), false);
});

test('existing output directory and all of its bytes are preserved', t => {
  const f = fixture(t);
  fs.mkdirSync(f.output);
  const sentinel = Buffer.from([255, 0, 128, 10]);
  fs.writeFileSync(path.join(f.output, 'original.txt'), sentinel);
  fs.writeFileSync(path.join(f.output, 'keep.txt'), 'keep');
  refused(f.run(), /OUTPUT_ALREADY_EXISTS/);
  assert.deepEqual(fs.readdirSync(f.output).sort(), ['keep.txt', 'original.txt']);
  assert.deepEqual(fs.readFileSync(path.join(f.output, 'original.txt')), sentinel);
  assert.equal(fs.readFileSync(path.join(f.output, 'keep.txt'), 'utf8'), 'keep');
});

test('existing output file is preserved', t => {
  const f = fixture(t);
  fs.writeFileSync(f.output, 'existing file');
  refused(f.run(), /OUTPUT_ALREADY_EXISTS/);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'existing file');
});

for (const location of ['source child', 'source parent', 'kit child', 'kit parent']) {
  test(`refuses output overlapping ${location}`, t => {
    const f = fixture(t);
    const root = location.startsWith('source') ? f.source : f.kit;
    const output = location.endsWith('child') ? path.join(root, 'new candidate') : path.dirname(root);
    refused(f.run({output}), /OUTPUT_MUST_BE_SEPARATE/);
    assert.equal(fs.readFileSync(path.join(f.source, 'original.txt'), 'utf8'), 'original');
    if (location.endsWith('child')) assert.equal(fs.existsSync(output), false);
  });
}

test('source file symlink is refused before output', t => {
  const f = fixture(t);
  const target = path.join(f.source, 'target.txt');
  fs.renameSync(path.join(f.source, 'original.txt'), target);
  if (!createLink(t, target, path.join(f.source, 'original.txt'), 'file')) return;
  refused(f.run(), /SOURCE_LINK_NOT_ALLOWED/);
  assert.equal(fs.existsSync(f.output), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});

for (const location of ['source', 'output']) {
  test(`${location} directory ancestor symlink is refused before output`, t => {
    const f = fixture(t);
    const link = path.join(f.dir, 'linked ancestor');
    if (!createLink(t, f.dir, link, 'dir')) return;
    const options = {[location]: path.join(link, path.basename(f[location]))};
    refused(f.run(options), /SOURCE_LINK_NOT_ALLOWED/);
    assert.equal(fs.existsSync(f.output), false);
    assert.equal(fs.readFileSync(path.join(f.source, 'original.txt'), 'utf8'), 'original');
  });
}

for (const location of ['source', 'output']) {
  test(`Windows ${location} ancestor junction is refused before output`, {skip: windowsOnly}, t => {
    const f = fixture(t);
    const link = path.join(f.dir, 'junction ancestor');
    if (!createLink(t, f.dir, link, 'junction')) return;
    refused(f.run({[location]: path.join(link, path.basename(f[location]))}), /SOURCE_LINK_NOT_ALLOWED/);
    assert.equal(fs.existsSync(f.output), false);
  });
}

for (const location of ['source', 'kit']) {
  test(`Windows case-insensitive ${location} containment refuses nested output`, {skip: windowsOnly}, t => {
    const f = fixture(t);
    const root = f[location];
    const changedCase = path.join(path.dirname(root), path.basename(root).toUpperCase());
    assert.notEqual(changedCase, root);
    // Confirm that this is a real alias on the test volume, not a path.win32 simulation.
    assert.equal(fs.realpathSync(changedCase).toLowerCase(), fs.realpathSync(root).toLowerCase());
    const output = path.join(changedCase, 'must not be created');
    refused(f.run({output}), /OUTPUT_MUST_BE_SEPARATE/);
    assert.equal(fs.existsSync(output), false);
  });
}
