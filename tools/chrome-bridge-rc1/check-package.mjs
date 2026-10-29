// Offline checks for the published updater kit; the original ZIP is not required.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const kit = path.dirname(fileURLToPath(import.meta.url));
const overlay = path.join(kit, 'overlay');
const baseline = path.join(kit, 'baseline-source');
const manifest = JSON.parse(readFileSync(path.join(kit, 'update-manifest.json'), 'utf8'));
const sourceManifest = JSON.parse(readFileSync(path.join(kit, 'source-manifest.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 1, 'Unsupported update manifest schema');
assert.equal(sourceManifest.schemaVersion, 1, 'Unsupported source manifest schema');
assert.ok(manifest.updatedFiles && typeof manifest.updatedFiles === 'object' &&
  !Array.isArray(manifest.updatedFiles), 'Missing updatedFiles map');
const expected = Object.keys(manifest.updatedFiles).sort();
assert.equal(expected.length, 37, 'Release must contain all 37 overlay files');

function inventory(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return inventory(path.join(directory, entry.name), relative + '/');
    assert.ok(entry.isFile(), `Package contains a non-regular file: ${relative}`);
    return [relative];
  });
}

function verifyFiles(directory, files, label, count) {
  assert.ok(files && typeof files === 'object' && !Array.isArray(files), `Missing ${label} file map`);
  const names = Object.keys(files).sort();
  assert.equal(names.length, count, `Unexpected ${label} file count`);
  assert.deepEqual(inventory(directory).sort(), names, `${label} inventory differs from manifest`);
  for (const relative of names) {
    assert.ok(!relative.includes('\\') && !relative.includes(':') &&
      relative.split('/').every(part => part && part !== '.' && part !== '..'),
    `Invalid ${label} path: ${relative}`);
    const expectedHash = files[relative];
    assert.match(expectedHash, /^[a-f0-9]{64}$/, `Invalid SHA256 for ${relative}`);
    const actualHash = createHash('sha256').update(readFileSync(path.join(directory, relative))).digest('hex');
    assert.equal(actualHash, expectedHash, `${label} SHA256 mismatch: ${relative}`);
  }
  console.log(`Verified ${names.length} byte-exact ${label} SHA256 hashes and inventory.`);
  return names;
}
verifyFiles(overlay, manifest.updatedFiles, 'Overlay', expected.length);
const original = verifyFiles(baseline, sourceManifest.baselineFiles, 'Baseline', 39);
for (const relative of original) {
  assert.equal(sourceManifest.baselineFiles[relative], manifest.originalFiles?.[relative],
    `Baseline provenance differs from originalFiles: ${relative}`);
}
console.log(`Verified all ${original.length} baseline files against originalFiles provenance.`);

let parsed = 0;
for (const [directory, files] of [[overlay, expected], [baseline, original]]) {
  for (const relative of files.filter(relative => /\.(?:mjs|js)$/.test(relative))) {
    const result = spawnSync(process.execPath, ['--check', path.join(directory, relative)], {
      encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `JavaScript syntax failed: ${relative}\n${result.stderr}`);
    parsed++;
  }
}
console.log(`Parsed ${parsed} JavaScript files without executing package code.`);
console.log('Source-only checks do not establish native Windows isolation or live provider acceptance.');
