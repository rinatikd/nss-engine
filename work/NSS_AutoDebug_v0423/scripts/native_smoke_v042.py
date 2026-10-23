"""Read-only smoke in a NEW AutoCAD process on a fixture COPY. Never kills a host."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root))
from nss_engine.contract_v042 import validate_snapshot
from nss_engine.runtime_validation_v041 import validate


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()


def collect(run):
    state=json.loads((run/'status.json').read_text())
    reports=run/'reports';snapshots=list(reports.glob('snapshot_v042_*.json'))
    if not snapshots or not (reports/'runtime_validation_v041.json').exists():return False
    snapshot=json.loads(snapshots[-1].read_text(encoding='utf-8-sig'));validate_snapshot(snapshot)
    inventory=json.loads((reports/'runtime_validation_v041.json').read_text(encoding='utf-8-sig'))
    if not validate(inventory)['valid']:raise ValueError('inventory failed')
    if inventory['counts']!=dict(lines=1,polylines=2,blocks=1,other=1,failed=0):raise ValueError('unexpected inventory')
    if snapshot['coverage']!=dict(visited=5,exported=4,skipped=1,truncated=False,complete=False):raise ValueError('unexpected coverage')
    if Path(snapshot['drawing']['name']).name!='fixture_copy.dxf':raise ValueError('drawing mismatch')
    host=snapshot['host']
    if host['dbmod_before']!=host['dbmod_after'] or host['assembly_version']!='0.42.0.0':raise ValueError('host state mismatch')
    if sha(Path(state['dll']))!=state['dll_sha256'] or sha(run/'fixture_copy.dxf')!=state['fixture_sha256']:raise ValueError('file changed')
    if sorted(e['type'] for e in snapshot['entities'])!=['INSERT','LINE','LWPOLYLINE','LWPOLYLINE']:raise ValueError('record types mismatch')
    line=next(e for e in snapshot['entities'] if e['type']=='LINE')
    if sorted(v[2] for v in line['vertices'])!=[2,7]:raise ValueError('Z lost')
    state['phase']='PASSED_READONLY_SMOKE';state['snapshot']=str(snapshots[-1]);state['note']='Only five-object fixture checked; preview writing and production drawings NOT tested'
    (run/'status.json').write_text(json.dumps(state,indent=2),encoding='utf8');print(json.dumps(state));return True


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--dll',type=Path);p.add_argument('--timeout',type=int,default=120)
    p.add_argument('--autocad',type=Path,default=Path(r'C:\Program Files\Autodesk\AutoCAD 2026\acad.exe'))
    p.add_argument('--collect',type=Path);p.add_argument('--prepare',action='store_true')
    args=p.parse_args()
    if args.collect:return 0 if collect(args.collect.resolve()) else 2
    dll=(args.dll or root/'Deploy/NssEngine.Export.dll').resolve()
    if not dll.is_file():raise FileNotFoundError(dll)
    run=root/'NativeTests'/uuid.uuid4().hex;run.mkdir(parents=True);(run/'reports').mkdir()
    shutil.copy2(root/'RuntimeFixture/runtime_fixture_v042.dxf',run/'fixture_copy.dxf')
    (run/'verify.scr').write_text('(command "_.NETLOAD" (getenv "NSS_PLUGIN_DLL"))\nNSS_VALIDATE_V041\nNSS_EXPORT_V042\n',encoding='ascii')
    state=dict(phase='PREPARED',dll=str(dll),dll_sha256=sha(dll),fixture_sha256=sha(run/'fixture_copy.dxf'))
    command=[str(args.autocad),str(run/'fixture_copy.dxf'),'/b',str(run/'verify.scr'),'/nologo'];state['command']=command
    (run/'status.json').write_text(json.dumps(state,indent=2),encoding='utf8');print(run,flush=True)
    if args.prepare:return 0
    env=os.environ.copy();env['NSS_PLUGIN_DLL']=str(dll);env['NSS_REPORT_DIR']=str(run/'reports')
    (run/'temp').mkdir();env['TEMP']=env['TMP']=str(run/'temp')
    with (run/'host.log').open('wb') as log:
        proc=subprocess.Popen(command,env=env,cwd=run,stdout=log,stderr=subprocess.STDOUT)
        state.update(phase='STARTED',pid=proc.pid);(run/'status.json').write_text(json.dumps(state,indent=2),encoding='utf8')
        until=time.monotonic()+args.timeout
        while time.monotonic()<until:
            if collect(run):return 0
            if proc.poll() is not None:state.update(phase='HOST_EXITED_WITHOUT_REPORTS',exit_code=proc.returncode);break
            time.sleep(1)
        else:state['phase']='TIMEOUT_NOT_VERIFIED'
    (run/'status.json').write_text(json.dumps(state,indent=2),encoding='utf8');print(json.dumps(state));return 2


if __name__=='__main__':raise SystemExit(main())
