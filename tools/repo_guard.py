#!/usr/bin/env python3
"""Check the staged Git snapshot or a committed tree without printing secret values."""
from __future__ import annotations
import argparse, ast, os, re, subprocess, sys
from pathlib import Path, PurePosixPath
ROOT=Path(__file__).resolve().parents[1]
GIT=['git','-c','safe.directory='+ROOT.as_posix()]
BANNED_SUFFIX={'.dwg','.dxf','.dwt','.dws','.rvt','.rfa','.rte','.rft','.ifc','.nwc','.nwd','.zip','.7z','.rar','.tar','.gz','.bz2','.xz','.whl','.nupkg','.dll','.exe','.pdb','.so','.dylib','.lib','.a','.pyc','.pyo','.db','.sqlite','.sqlite3','.dmp','.dump','.bak','.tmp','.log','.err','.jsonl','.ndjson','.pem','.key','.pfx','.p12'}
BANNED_DIR={'.git','.venv','venv','env','runtime','node_modules','__pycache__','bin','obj','runs','evidence','history','graphify-out','dumps','dump','secrets','local-backups','.aws','.ssh','.codex','.claude','.cursor','.gemini'}
PATTERNS={
 'private-key':re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
 'github-token':re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{45,})\b'),
 'openai-like-key':re.compile(rb'\bsk-(?:proj-|svcacct-|ant-api\d+-)?[A-Za-z0-9_-]{35,}\b'),
 'aws-access-key':re.compile(rb'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'),
 'slack-token':re.compile(rb'\bxox[baprs]-[A-Za-z0-9-]{25,}\b'),
 'google-api-key':re.compile(rb'\bAIza[0-9A-Za-z_-]{35}\b'),
 'jwt':re.compile(rb'\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b'),
}
ASSIGN=re.compile(rb'''(?i)(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*['"]([^'"\r\n]{12,})['"]''')
PLACEHOLDERS=(b'example',b'placeholder',b'your',b'change',b'replace',b'dummy',b'test',b'xxx',b'...',b'${',b'getenv',b'environ',b'<',b'process.env',b'secret_name')

def git(*args):
 p=subprocess.run(GIT+list(args),cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode:raise RuntimeError(p.stderr.decode('utf-8',errors='replace').strip())
 return p.stdout

def entries(tree):
 result=[]
 if tree:
  for raw in git('ls-tree','-r','-z',tree).split(b'\0'):
   if raw:
    meta,path=raw.split(b'\t',1);mode,kind,oid=meta.split();result.append((mode.decode(),oid.decode(),path.decode('utf-8')))
 else:
  for raw in git('ls-files','--stage','-z').split(b'\0'):
   if raw:
    meta,path=raw.split(b'\t',1);mode,oid,stage=meta.split()
    if stage!=b'0':raise RuntimeError('Unmerged index entries must be resolved before publication.')
    result.append((mode.decode(),oid.decode(),path.decode('utf-8')))
 return result

def main():
 p=argparse.ArgumentParser();p.add_argument('--staged',action='store_true');p.add_argument('--tree');args=p.parse_args()
 problems=[];items=entries(args.tree);total=0
 if not items:problems.append(('(index)','empty-snapshot'))
 for mode,oid,path in items:
  pp=PurePosixPath(path);lower=[x.lower() for x in pp.parts];name=pp.name.lower()
  if mode not in ('100644','100755'):problems.append((path,'nonportable-link-or-submodule'));continue
  if pp.suffix.lower() in BANNED_SUFFIX or any(x in BANNED_DIR for x in lower[:-1]):problems.append((path,'excluded-artifact'))
  if name=='.env' or name.startswith('.env.') or name in ('auth.json','credentials.json','secrets.json','.git-credentials','.netrc'):problems.append((path,'credential-file'))
  if pp.suffix.lower()=='.json' and path!='skills-lock.json' and not path.startswith('.agents/skills/'):problems.append((path,'local-json-or-dump'))
  if pp.suffix.lower()=='.csv' and name!='catalog.csv':problems.append((path,'local-csv-or-dump'))
  data=git('cat-file','blob',oid);total+=len(data)
  if len(data)>2*1024*1024:problems.append((path,'blob-over-2MiB'))
  if b'\0' in data:problems.append((path,'binary-content'));continue
  for label,pattern in PATTERNS.items():
   for match in pattern.finditer(data):
    if any(t in match.group().lower() for t in PLACEHOLDERS):continue
    line=data.count(b'\n',0,match.start())+1;problems.append((path,f'{label}:line-{line}'))
  for match in ASSIGN.finditer(data):
   value=match.group(1).lower()
   if not any(t in value for t in PLACEHOLDERS):
    # Expressions and format strings are not literal credentials.
    if any(t in value for t in (b'(',b')',b'{',b'}',b'\\',b' ',b'$')):continue
    line=data.count(b'\n',0,match.start())+1;problems.append((path,f'credential-literal-review:line-{line}'))
 if total>30*1024*1024:problems.append(('(snapshot)','source-snapshot-over-30MiB'))
 if problems:
  for path,reason in sorted(set(problems)):print(f'BLOCK {path}: {reason}')
  print(f'FAILED: {len(set(problems))} finding(s); values are redacted.');return 1
 print(f'PASS: {len(items)} text files, {total:,} bytes; no prohibited artifacts or detected secret patterns.');return 0
if __name__=='__main__':
 try:sys.exit(main())
 except Exception as e:print(f'ERROR: {e}',file=sys.stderr);sys.exit(2)
