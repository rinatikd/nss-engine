import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('NATIVE_TEST_REQUIRES_WINDOWS_X64');
}
const require = createRequire(import.meta.url);
const binary = path.join(path.dirname(fileURLToPath(import.meta.url)),
  'build', 'Release', 'powershell_direct_native.node');
const addon = require(binary);
assert.equal(typeof addon.getBuildInfo, 'function');
const info = addon.getBuildInfo();
assert.equal(info.platform, 'win32');
assert.equal(info.arch, 'x64');
assert.equal(info.backend, 'job-object-bootstrap-only');
assert.ok(Number.isInteger(info.napiVersion) && info.napiVersion >= 8);
console.log('PASS: native N-API module loaded; build metadata verified');
