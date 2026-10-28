// Reconstructs a source-only candidate from checked-in, hash-verified files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const kit = path.dirname(fileURLToPath(import.meta.url));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const metadataName = 'CANDIDATE_READY.json';

function relative(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') ||
      path.posix.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw Error('INVALID_MANIFEST_PATH');
  }
  // Require portable names so the same manifest cannot alias files on Windows.
  if (name.split('/').some(part => /[<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('INVALID_MANIFEST_PATH');
  return path.join(root, ...name.split('/'));
}

function assertNoLinkedAncestors(target) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw Error('SOURCE_LINK_NOT_ALLOWED');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function contains(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

function readRegular(root, name) {
  const target = relative(root, name);
  assertNoLinkedAncestors(target);
  if (!fs.statSync(target).isFile()) throw Error('SOURCE_FILE_REQUIRED');
  return fs.readFileSync(target);
}

function manifest(name, field) {
  const value = JSON.parse(readRegular(kit, name).toString('utf8'));
  const files = value[field];
  if (value.schemaVersion !== 1 || !files || typeof files !== 'object' || Array.isArray(files)) {
    throw Error('UNSUPPORTED_MANIFEST: ' + name);
  }
  for (const [entry, expected] of Object.entries(files)) {
    relative(kit, entry);
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw Error('INVALID_MANIFEST_HASH: ' + entry);
  }
  return value;
}

function validateOutputNames(content) {
  const names = [...content.keys()].map(name => name.toLowerCase());
  const unique = new Set(names);
  const marker = metadataName.toLowerCase();
  if (unique.size !== names.length || unique.has(marker)) throw Error('INVALID_MANIFEST_COLLISION');
  for (const name of names) {
    const parts = name.split('/');
    while (parts.length > 1) {
      parts.pop();
      const ancestor = parts.join('/');
      if (unique.has(ancestor) || ancestor === marker) throw Error('INVALID_MANIFEST_COLLISION');
    }
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !args[1]) throw Error('Use --output <new candidate folder>');
  const output = path.resolve(args[1]);
  assertNoLinkedAncestors(kit);
  assertNoLinkedAncestors(output);
  if (contains(kit, output) || contains(output, kit)) throw Error('OUTPUT_MUST_BE_SEPARATE');
  if (fs.existsSync(output)) throw Error('OUTPUT_ALREADY_EXISTS_CHOOSE_NEW_FOLDER');
  const baseline = manifest('source-manifest.json', 'baselineFiles');
  const update = manifest('update-manifest.json', 'updatedFiles');
  const content = new Map();
  for (const [root, files, failure] of [
    [path.join(kit, 'baseline-source'), baseline.baselineFiles, 'BASELINE_INTEGRITY_FAILURE'],
    [path.join(kit, 'overlay'), update.updatedFiles, 'UPDATE_INTEGRITY_FAILURE'],
  ]) {
    for (const [name, expected] of Object.entries(files)) {
      const bytes = readRegular(root, name);
      if (digest(bytes) !== expected) throw Error(failure + ': ' + name);
      content.set(name, bytes);
    }
  }
  // Validate the merged tree before creating output, including case aliases,
  // file/directory collisions, and the reserved verification marker.
  validateOutputNames(content);
  fs.mkdirSync(output, {recursive: true, mode: 0o700});
  for (const [name, bytes] of content) {
    const target = relative(output, name);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, bytes, {flag: 'wx'});
  }
  for (const [name, bytes] of content) {
    if (digest(fs.readFileSync(relative(output, name))) !== digest(bytes)) throw Error('OUTPUT_VERIFICATION_FAILED: ' + name);
  }
  const ready = {
    version: update.version, files: content.size, verified: true, SOURCE_ONLY_CANDIDATE: true,
    nativeWindowsVerified: false, liveWebsitesVerified: false, createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(output, metadataName), JSON.stringify(ready, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({...ready, output}, null, 2));
} catch (error) {
  console.error(/^(Use |SOURCE_|INVALID_|OUTPUT_|UNSUPPORTED_|BASELINE_|UPDATE_)/.test(error.message)
    ? error.message : 'SOURCE_CANDIDATE_FAILED: required checked-in files are missing, unreadable or incomplete.');
  process.exitCode = 1;
}
