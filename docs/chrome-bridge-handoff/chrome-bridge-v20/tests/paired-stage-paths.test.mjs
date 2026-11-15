import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const here=path.dirname(fileURLToPath(import.meta.url));
const source=readFileSync(path.join(here,'../deployment/Stage-Paired-Lab17484.ps1'),'utf8');

test('stager rejects destinations inside source checkout using one directory separator',()=>{
  assert.match(source,/OUTPUT_INSIDE_SOURCE_CHECKOUT_DENIED/);
  assert.match(source,/\$repoPath=.+TrimEnd\(\[char\]92\)/);
  assert.match(source,/\$sourcePath=.+TrimEnd\(\[char\]92\)/);
  assert.match(source,/\$normalized\.StartsWith\(\(\$repoPath\+\[System\.IO\.Path\]::DirectorySeparatorChar\)/);
  assert.match(source,/\$normalized\.StartsWith\(\(\$sourcePath\+\[System\.IO\.Path\]::DirectorySeparatorChar\)/);
  assert.doesNotMatch(source,/TrimEnd\('\\\\'\)/);
  assert.doesNotMatch(source,/\$repoPath\+'\\\\'/);
  assert.doesNotMatch(source,/\$sourcePath\+'\\\\'/);
});

test('Windows path containment distinguishes a checkout child from a sibling',()=>{
  const root=path.win32.normalize('C:\\Engineering\\nss-engine');
  const sep=path.win32.sep;
  const inside=(candidate)=>candidate.toLowerCase()===root.toLowerCase() ||
    candidate.toLowerCase().startsWith((root+sep).toLowerCase());
  assert.equal(inside('C:\\Engineering\\nss-engine'),true);
  assert.equal(inside('C:\\Engineering\\nss-engine\\output'),true);
  assert.equal(inside('c:\\engineering\\NSS-ENGINE\\build'),true);
  assert.equal(inside('C:\\Engineering\\nss-engine-other\\output'),false);
  assert.equal(inside('C:\\Engineering\\PR113-Paired-Lab17484'),false);
});

test('release staging discovers all Node suites rather than a stale hardcoded list',()=>{
  assert.match(source,/Get-ChildItem -LiteralPath \(Join-Path \$source 'tests'\) -Filter '\*\.test\.mjs'/);
  assert.match(source,/\& \$node --test @testPaths/);
  const zip=readFileSync(path.join(here,'../deployment/Test-PR113-ZipSource.ps1'),'utf8');
  assert.match(zip,/Get-ChildItem -LiteralPath \(Join-Path \$source 'tests'\) -Filter '\*\.test\.mjs'/);
  assert.match(zip,/\& \$Node --test @tests/);
});
