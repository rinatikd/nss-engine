import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../native/image_inspector.cpp', import.meta.url), 'utf8');

test('native inspector binds signature, hash, identity and ACL reads to one open handle', () => {
  assert.match(source, /CreateFileW\(path\.c_str\(\), GENERIC_READ\|READ_CONTROL, FILE_SHARE_READ/);
  assert.match(source, /FILE_FLAG_OPEN_REPARSE_POINT/);
  assert.match(source, /GetFileInformationByHandleEx\(file, FileIdInfo/);
  assert.match(source, /WINTRUST_FILE_INFO fi\{\}; fi\.cbStruct=sizeof\(fi\); fi\.pcwszFilePath=finalPath\.c_str\(\); fi\.hFile=file/);
  assert.match(source, /GetSecurityInfo\(file, SE_FILE_OBJECT/);
  assert.match(source, /BCryptHashData\(hash, buf\.data\(\), n, 0\)/);
  assert.match(source, /signerPinOk=equalHex\(expectedSigner, actualSigner\)/);
});

test('inspector refuses reparse points, hardlinks, inherited or broad writable ACLs', () => {
  assert.match(source, /FILE_ATTRIBUTE_REPARSE_POINT/);
  assert.match(source, /standard\.NumberOfLinks!=1/);
  assert.match(source, /SE_DACL_PROTECTED/);
  assert.match(source, /header->AceFlags & INHERITED_ACE/);
  assert.match(source, /FILE_WRITE_DATA.*FILE_APPEND_DATA.*FILE_WRITE_EA.*FILE_WRITE_ATTRIBUTES.*FILE_DELETE_CHILD.*DELETE.*WRITE_DAC.*WRITE_OWNER.*GENERIC_WRITE.*GENERIC_ALL/);
});

test('inspection is fail-closed and cannot launch a process or authorize execution', () => {
  assert.doesNotMatch(source, /\b(CreateProcess|ShellExecute|WinExec|system\s*\(|_popen|std::system)\w*/);
  assert.match(source, /executionAuthorized\\\":false/);
  assert.match(source, /return imageOk && ownerOk && protectedDacl && aclOk \? 0 : 10/);
});

test('diagnostic output redacts the candidate path and includes native file identity', () => {
  assert.match(source, /GetFinalPathNameByHandleW\(file/);
  assert.match(source, /pathRedacted\\\":true/);
  assert.match(source, /fileIdVolumeSerial/);
  assert.doesNotMatch(source, /<<\s*path\s*<</);
});
