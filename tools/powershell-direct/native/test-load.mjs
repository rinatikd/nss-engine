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
assert.equal(typeof addon.createOperation, 'function');
assert.equal(typeof addon.closeOperation, 'function');

const info = addon.getBuildInfo();
assert.equal(info.platform, 'win32');
assert.equal(info.arch, 'x64');
assert.equal(info.backend, 'job-object-registry-bootstrap');
assert.ok(Number.isInteger(info.napiVersion) && info.napiVersion >= 8);

const operationId = addon.createOperation();
assert.match(operationId, /^[0-9a-f]{32}$/);
assert.equal(addon.closeOperation(operationId), true);
assert.equal(addon.closeOperation(operationId), true,
  'closing an already-closed operation must be idempotent');

assert.throws(() => addon.closeOperation('0'.repeat(32)),
  error => error && error.code === 'UNKNOWN_OPERATION');
assert.throws(() => addon.closeOperation('not-an-operation-id'),
  error => error && error.code === 'INVALID_OPERATION_ID');
assert.throws(() => addon.closeOperation(),
  error => error && error.code === 'INVALID_ARGUMENT');

const uniqueIds = new Set(Array.from({length: 256}, () => addon.createOperation()));
assert.equal(uniqueIds.size, 256, 'operation IDs must be unique');
for (const id of uniqueIds) addon.closeOperation(id);

console.log('PASS: native N-API module loaded; ABI and operation registry verified');
