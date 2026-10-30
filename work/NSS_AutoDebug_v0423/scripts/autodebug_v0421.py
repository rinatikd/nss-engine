"""One-click AutoCAD regression run. No user drawing is edited or saved."""
import argparse
from datetime import datetime
import hashlib
import html
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
import zipfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from nss_engine.contract_v042 import validate_snapshot,length_units
from nss_engine.runtime_validation_v041 import validate as validate_inventory
from nss_engine.host_diagnostics_v0422 import diagnose

CASES={
    'preview_undo_disabled_refused_without_changes',
    'native_inventory','native_XYZ_bulge_attributes_export','read_only_active_drawing',
    'preview_decline_no_changes','preview_invalid_payload_no_changes','preview_create_owned_nonplot',
    'preview_clear_decline_no_changes','preview_clear_preserves_foreign_same_layer',
    'preview_repeated_cleanup_idempotent','preview_fault_injection_rolls_back_entities_and_layers',
    'preview_plottable_foreign_layer_refused','active_drawing_unchanged_after_side_database_tests',
    'fixture_file_unchanged','production_python_bridge_dispatched',
}


def sha(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def read(path):return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write(path,data):
    path=Path(path);tmp=path.with_suffix(path.suffix+'.tmp')
    tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf8');tmp.replace(path)


def under(path,parent):
    return Path(path).resolve().is_relative_to(Path(parent).resolve())


def collect(run):
    """Return None while running. Reject stale/mismatched/partial success reports."""
    run=Path(run).resolve();state=read(run/'status.json');reports=run/'reports'
    if (reports/'bootstrap_error.json').exists():
        error=read(reports/'bootstrap_error.json')
        if error.get('run_id')!=state['run_id']:raise ValueError('stale bootstrap error run id')
        raise ValueError('BOOTSTRAP_FAILED: '+error.get('code','UNKNOWN')+'; see reports/bootstrap_error.txt')
    native=reports/'native_results.json'
    if not native.is_file():return None
    result=read(native)
    if result.get('run_id')!=state['run_id']:raise ValueError('native run id mismatch')
    if result.get('assembly_version')!='0.42.3.0' or result.get('dll_sha256')!=state['dll_sha256']:raise ValueError('wrong native assembly')
    if sha(state['dll'])!=state['dll_sha256'] or sha(state['fixture'])!=state['fixture_sha256']:raise ValueError('DLL or fixture changed')
    if result.get('source_sha256')!=state['fixture_sha256']:raise ValueError('wrong native input')
    cases=result.get('cases',[])
    if len(cases)!=len(CASES) or {c['name'] for c in cases}!=CASES:raise ValueError('missing or duplicate native checks')
    if result.get('preview_test_scope')!='private_disposable_database_only':raise ValueError('unsafe test scope')
    if result.get('failures')!=0 or any(c.get('passed') is not True for c in cases):raise ValueError('native test failure; inspect native_results.json')
    if result.get('phase')!='NATIVE_CHECKS_PASSED_WAITING_FOR_PYTHON':raise ValueError('native stage did not pass')
    snapshots=list(reports.glob('snapshot_v042_*.json'))
    if len(snapshots)!=1:raise ValueError('missing or multiple native snapshots')
    snapshot=read(snapshots[0]);validate_snapshot(snapshot)
    if snapshot['producer']!='AutoCAD' or snapshot['drawing']['name']!=Path(state['fixture']).name:raise ValueError('wrong export provenance')
    host=snapshot['host']
    if host['assembly_version']!='0.42.3.0' or host['dbmod_before']!=host['dbmod_after']:raise ValueError('DBMOD changed or wrong export version')
    coverage=dict(visited=9,exported=8,skipped=1,truncated=False,complete=False)
    if snapshot['coverage']!=coverage:raise ValueError('unexpected coverage')
    records=snapshot['entities']
    if not any(e['type']=='LINE' and e['vertices']==[[0,0,2],[0,0,7]] and length_units(e)==5 for e in records):raise ValueError('lost Z')
    polys=[e for e in records if e['type']=='LWPOLYLINE']
    if sorted(e['bulges'][0] for e in polys)!=[-1,1] or not any(e['normal']==[0,1,0] for e in polys):raise ValueError('lost bulge/normal')
    if not any(e['type']=='INSERT' and e['vertices']==[[10,20,3]] and e['attributes'].get('CODE')=='\u041a\u041a\u0421-1' for e in records):raise ValueError('lost block/attributes')
    inventory=read(reports/'runtime_validation_v041.json')
    if not validate_inventory(inventory)['valid'] or inventory['counts']!=dict(lines=5,polylines=2,blocks=1,other=1,failed=0):raise ValueError('bad inventory')
    if inventory['drawing_id']!=snapshot['drawing']['id']:raise ValueError('inconsistent drawing identity')
    job=Path(result.get('python_job') or '')
    if not job.is_absolute() or not under(job,reports) or job.parent.resolve()!=reports.resolve():raise ValueError('Python job escaped run folder')
    if not (job/'status.json').exists():return None
    status=read(job/'status.json')
    if status.get('phase')=='RUNNING':return None
    if status.get('phase')!='COMPLETED_REVIEW_REQUIRED':raise ValueError('Python analysis failed; see job status/error.log')
    if status.get('snapshot_sha256')!=sha(snapshots[0]):raise ValueError('Python used a different snapshot')
    analysis=read(job/'analysis_v042.json')
    if analysis['drawing']!=snapshot['drawing'] or analysis['source_coverage']!=coverage:raise ValueError('wrong Python drawing/coverage')
    if analysis['classifications']!=dict(unknown=3,telecom=4,water=1):raise ValueError('unexpected recognition')
    summary=analysis['screening']['summary']
    if summary['segments']!=3 or summary['utilities']!=1 or summary['components']!=1:raise ValueError('unexpected native-to-Python topology')
    codes=[f['code'] for f in analysis['screening']['findings']]
    if codes.count('DUPLICATE_SEGMENT')!=1 or codes.count('UTILITY_CROSSING')!=2:raise ValueError('intersection/duplicate regression')
    if analysis['physical_connectivity_confirmed'] or analysis['normative_compliance_verified']:raise ValueError('unsupported compliance claim')
    return dict(native_cases=len(cases),python_status=status['phase'],topology=summary,
                scope='Synthetic nine-object fixture and isolated preview database; not production engineering acceptance')


def fixture(path):
    import ezdxf
    from nss_engine.runtime_fixture_v042 import create_document
    path=Path(path)
    if path.exists():raise FileExistsError('fixture output must be new: '+str(path))
    base=ROOT/'RuntimeFixture/runtime_fixture_v042.dxf'
    # A source checkout has no bundled DXF. Build the same tiny base in memory;
    # only the new run's fixture is saved, never RuntimeFixture or a user file.
    doc=ezdxf.readfile(base) if base.is_file() else create_document()
    for layer in ('NSS_NETWORK','\u0412\u043e\u0434\u043e\u043f\u0440\u043e\u0432\u043e\u0434'):
        if layer not in doc.layers:doc.layers.new(layer)
    model=doc.modelspace()
    for a,b in (((0,10),(10,10)),((10,10),(10,20)),((10,10),(0,10))):model.add_line(a,b,dxfattribs={'layer':'NSS_NETWORK'})
    model.add_line((5,5),(5,15),dxfattribs={'layer':'\u0412\u043e\u0434\u043e\u043f\u0440\u043e\u0432\u043e\u0434'})
    doc.saveas(path)


def lisp_string(value):
    return '"'+str(value).replace('\\','/').replace('"','\\"')+'"'


def make_in_host_bootstrap(run,state):
    """SCRIPT keeps command sequencing across opening the new test drawing."""
    run=Path(run).resolve()
    script=run/'in_host.scr'
    invoke=make_invoker(run,state)
    script.write_text('_.OPEN\n'+lisp_string(state['fixture'])+'\n'+
        '(load '+lisp_string(invoke)+')\n',encoding='utf8')
    text=('; Generated NSS test only. Reuse active fixture; never reopen an open document.\n'+
          '(vl-load-com)\n'+
          '(setq nss-fixture '+lisp_string(state['fixture'])+')\n'+
          '(setq nss-current (vl-string-translate "\\\\" "/" (strcat (getvar "DWGPREFIX") (getvar "DWGNAME"))))\n'+
          '(if (= (strcase nss-current) (strcase nss-fixture))\n'+
          '  (load '+lisp_string(invoke)+')\n'+
          '  (progn\n'+
          '    (setq nss-open nil)\n'+
          '    (vlax-for nss-doc (vla-get-Documents (vlax-get-acad-object))\n'+
          '      (if (= (strcase (vl-string-translate "\\\\" "/" (vla-get-FullName nss-doc))) (strcase nss-fixture)) (setq nss-open T)))\n'+
          '    (if nss-open\n'+
          '      (princ "\\nNSS: activate the already open fixture_copy.dxf tab, then drop this loader again.")\n'+
          '      (command "_.SCRIPT" '+lisp_string(script)+'))\n'+
          '  )\n)\n(princ)\n')
    loader=run/'RUN_IN_AUTOCAD.lsp';loader.write_text(text,encoding='utf-8-sig')
    return loader


def registration(run_id):
    if len(run_id)!=32 or any(c not in '0123456789abcdef' for c in run_id):raise ValueError('invalid registration run id')
    return dict(assembly='NssEngine.AutoDebug.R'+run_id,entry='NSS_AUTOTEST_FILE_R'+run_id.upper(),command='NSS_AUTOTEST_R'+run_id.upper())


def make_invoker(run,state):
    run=Path(run).resolve();entry=state.get('entry_name','NSS_AUTOTEST_FILE_V0423_PREBUILT')
    if not entry.startswith('NSS_AUTOTEST_FILE_') or any(not(c.isalnum() or c=='_') for c in entry):raise ValueError('invalid native entry')
    function='nss-debug-fail-'+state['run_id']
    error_path=run/'reports/bootstrap_error.json';detail=run/'reports/bootstrap_error.txt'
    # Fixed ASCII JSON fields; arbitrary native error text goes to a separate text file.
    prefix=json.dumps(dict(phase='BOOTSTRAP_FAILED',run_id=state['run_id']),separators=(',',':'))[:-1]+',"code":"'
    lines=[
        '(vl-load-com)',
        '(defun '+function+' (code message / f)',
        '  (setq f (open '+lisp_string(error_path)+' "w"))',
        '  (if f (progn (write-line (strcat '+lisp_string(prefix)+' code "\\\"}") f) (close f)))',
        '  (setq f (open '+lisp_string(detail)+' "w"))',
        '  (if f (progn (write-line message f) (close f)))',
        '  (princ (strcat "\\nNSS bootstrap failed: " code " - " message))',
        ')',
        '(if (not (car (atoms-family 1 (list '+lisp_string(entry)+'))))',
        '  (vl-catch-all-apply \'(lambda () (command-s "_.NETLOAD" '+lisp_string(state['dll'])+')) nil))',
        '(if (not (car (atoms-family 1 (list '+lisp_string(entry)+'))))',
        '  ('+function+' "ASSEMBLY_OR_ENTRY_NOT_LOADED" "Native entry was not registered; inspect NETLOAD error in AutoCAD console.")',
        '  (progn',
        '    (setq nss-debug-result (vl-catch-all-apply \'(lambda () ('+entry+' '+lisp_string(run/'reports/authorization.json')+')) nil))',
        '    (if (vl-catch-all-error-p nss-debug-result)',
        '      ('+function+' "NATIVE_BOOTSTRAP_EXCEPTION" (vl-catch-all-error-message nss-debug-result)))',
        '  )',
        ')','(princ)',
    ]
    path=run/'reports/invoke.lsp';path.parent.mkdir(exist_ok=True);path.write_text('\n'.join(lines)+'\n',encoding='utf-8-sig');return path


def host_diagnosis(run,state):
    log=Path(run)/'host.log'
    return diagnose(log.read_bytes() if log.exists() else b'',state.get('host_exit_code'),(Path(run)/'reports/native_results.json').exists())


def artifacts(run):
    state=read(run/'status.json');phase=state['phase']
    report='<!doctype html><meta charset="utf-8"><title>NSS AutoDebug</title><h1>NSS AutoDebug: '+html.escape(phase)+'</h1><pre>'+html.escape(json.dumps(state,ensure_ascii=False,indent=2))+'</pre><p>Native preview uses a private in-memory database. Source drawings are not edited. PASSED is a fixture regression result, not engineering approval.</p>'
    native=run/'reports/native_results.json'
    if native.exists():
        data=read(native)
        report+='<h2>Native checks</h2><table border="1"><tr><th>Check</th><th>Passed</th><th>Error</th></tr>'
        for case in data.get('cases',[]):
            report+='<tr>'+''.join('<td>'+html.escape(str(v))+'</td>' for v in (case['name'],case['passed'],case.get('error') or ''))+'</tr>'
        report+='</table>'
    if state.get('host_diagnosis'):
        report+='<h2>Host startup diagnosis</h2><pre>'+html.escape(json.dumps(state['host_diagnosis'],ensure_ascii=False,indent=2))+'</pre>'
    report+='<p><a href="reports/native_results.json">Native JSON</a> | <a href="host.log">Host log</a> | <a href="python-tests.log">Offline test log</a> | <a href="RUN_IN_AUTOCAD.lsp">In-host fallback loader</a></p>'
    (run/'RESULT.html').write_text(report,encoding='utf8')
    zip_path=run.parent/(run.name+'_diagnostics.zip')
    with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED) as z:
        for f in sorted(run.rglob('*')):
            if f.is_file() and 'temp' not in f.relative_to(run).parts:z.write(f,f.relative_to(run).as_posix())
    with zipfile.ZipFile(zip_path) as z:
        if z.testzip() is not None:raise ValueError('diagnostic zip CRC failed')
    print('RESULT:',run/'RESULT.html',flush=True);print('SEND THIS FILE:',zip_path,flush=True)


def command(run,log,cmd,timeout=180):
    with (run/log).open('wb') as stream:
        result=subprocess.run(cmd,cwd=ROOT,stdout=stream,stderr=subprocess.STDOUT,timeout=timeout)
    if result.returncode:raise RuntimeError(f'{log}: command failed with code {result.returncode}')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--prepare',action='store_true');p.add_argument('--collect',type=Path)
    p.add_argument('--collect-last',action='store_true')
    p.add_argument('--timeout',type=int,default=180);p.add_argument('--use-prebuilt',action='store_true')
    p.add_argument('--in-host',action='store_true',help='Prepare a loader for normal AutoCAD, then wait for reports')
    p.add_argument('--autocad-dir',type=Path,default=Path(r'C:\Program Files\Autodesk\AutoCAD 2026'))
    a=p.parse_args()
    if a.collect_last:
        last=Path(read(ROOT/'LAST_RUN.json')['run'])
        if not under(last,ROOT/'Runs'):raise ValueError('last run escaped Runs folder')
        a.collect=last
    if a.collect:
        run=a.collect.resolve();state=read(run/'status.json')
        try:
            result=collect(run)
            if result is None:print('Reports not complete:',run);return 2
            state.update(phase='PASSED',result=result);write(run/'status.json',state);artifacts(run);return 0
        except Exception as error:state.update(phase='FAILED',error=str(error));write(run/'status.json',state);artifacts(run);return 2
    run=ROOT/'Runs'/(datetime.now().strftime('%Y%m%d_%H%M%S')+'_'+uuid.uuid4().hex[:8]);run.mkdir(parents=True)
    reports=run/'reports';reports.mkdir();state=dict(schema_version='0.42.3',run_id=uuid.uuid4().hex,phase='OFFLINE_CHECKS',offline={})
    write(run/'status.json',state);print('RUN:',run,flush=True)
    write(ROOT/'LAST_RUN.json',dict(run=str(run)))
    try:
        contract_fixture=None
        dotnet=shutil.which('dotnet')
        if dotnet and not a.use_prebuilt:
            names=registration(state['run_id'])
            source=run/'DebugRegistration.cs'
            source.write_text('namespace NssEngine.Export; internal static class DebugRegistration { public const string EntryName="'+names['entry']+'"; public const string CommandName="'+names['command']+'"; }',encoding='utf8')
            command(run,'dotnet-build.log',[dotnet,'build','autocad/NssEngine.Export.csproj','-c','Release','-o',str(run/'plugin'),'-p:AutoCADDir='+str(a.autocad_dir),'-p:AssemblyName='+names['assembly'],'-p:NssDebugRegistrationFile='+str(source),'-p:NuGetAudit=false','--nologo'])
            dll=run/'plugin'/(names['assembly']+'.dll');state['entry_name']=names['entry'];state['assembly_name']=names['assembly'];state['offline']['build']='PASSED'
            contract_fixture=run/'contract_fixture_v042.json'
            command(run,'contract-tests.log',[dotnet,'run','--project','contract_tests/ContractTests.csproj','-p:NuGetAudit=false','--',str(contract_fixture)])
            state['offline']['CSharp_contracts']='PASSED'
            inspect=run/'assembly_registration.json'
            command(run,'assembly-registration.log',[dotnet,'run','--project','contract_tests/ContractTests.csproj','-p:NuGetAudit=false','--','--inspect-assembly',str(dll),str(inspect)])
            data=read(inspect)
            if data['assembly']!=state['assembly_name'] or {e['name'] for e in data['entries']}!={names['entry'],names['command']} or len(data['entries'])!=2:raise ValueError('Unexpected or non-isolated AutoCAD registrations')
            state['offline']['isolated_registration']='PASSED'
        else:
            dll=ROOT/'Deploy/NssEngine.AutoDebug.V0423.dll';expected=read(ROOT/'Deploy/SHA256.json')
            if sha(dll)!=expected[dll.name]:raise ValueError('Packaged DLL checksum mismatch')
            state['offline'].update(build='NOT_RUN_USING_VERIFIED_PREBUILT',CSharp_contracts='NOT_RUN')
            state.update(entry_name='NSS_AUTOTEST_FILE_V0423_PREBUILT',assembly_name='NssEngine.AutoDebug.V0423')
        command(run,'python-tests.log',[sys.executable,'-E','-s','-X','utf8','scripts/run_portable_tests.py']+(['--contract-fixture',str(contract_fixture)] if contract_fixture else []))
        state['offline']['python']='PASSED'
        source=run/'fixture_copy.dxf';fixture(source)
        state.update(phase='PREPARED',dll=str(dll),dll_sha256=sha(dll),fixture=str(source),fixture_sha256=sha(source))
        write(reports/'authorization.json',dict(run_id=state['run_id'],drawing=str(source),drawing_sha256=state['fixture_sha256'],dll_sha256=state['dll_sha256'],allowed_scope='synthetic_fixture_and_private_database'))
        (run/'run.scr').write_text('(load (strcat (getenv "NSS_REPORT_DIR") "/invoke.lsp"))\n',encoding='ascii')
        loader=make_in_host_bootstrap(run,state)
        state['in_host_loader']=str(loader)
        write(run/'status.json',state)
        if a.prepare:print('PREPARED ONLY; AutoCAD not tested');artifacts(run);return 0
        if a.in_host:
            # Stable filename beside the launcher. The run-specific loader is preserved too.
            shutil.copy2(loader,ROOT/'RUN_IN_AUTOCAD.lsp')
            state.update(phase='WAITING_FOR_IN_HOST_TEST');write(run/'status.json',state)
            print('Open a normal NEW AutoCAD session, then drag this one file into its window:',ROOT/'RUN_IN_AUTOCAD.lsp',flush=True)
            until=time.monotonic()+a.timeout
            while time.monotonic()<until:
                result=collect(run)
                if result:state.update(phase='PASSED',result=result);break
                time.sleep(.5)
            else:state['phase']='TIMEOUT_NOT_VERIFIED'
            write(run/'status.json',state);artifacts(run);return 0 if state['phase']=='PASSED' else 2
        env=os.environ.copy();env.update(NSS_PLUGIN_DLL=str(dll),NSS_REPORT_DIR=str(reports),NSS_TEST_RUN_ID=state['run_id'])
        cmd=[str(a.autocad_dir/'acad.exe'),str(source),'/b',str(run/'run.scr'),'/nologo'];state['host_command']=cmd
        # Inherit the user's normal TEMP/profile; do not change AutoCAD security or settings.
        with (run/'host.log').open('wb') as log:
            process=subprocess.Popen(cmd,cwd=run,env=env,stdout=log,stderr=subprocess.STDOUT)
            state.update(phase='RUNNING_NATIVE_TESTS',pid=process.pid);write(run/'status.json',state)
            until=time.monotonic()+a.timeout
            while time.monotonic()<until:
                result=collect(run)
                if result:
                    state.update(phase='PASSED',result=result);break
                if process.poll() is not None:
                    state.update(phase='HOST_EXITED_WITHOUT_COMPLETE_REPORTS',host_exit_code=process.returncode);break
                time.sleep(.5)
            else:state['phase']='TIMEOUT_NOT_VERIFIED'
        if state['phase']!='PASSED':
            state['host_diagnosis']=host_diagnosis(run,state)
            print('HOST DIAGNOSIS:',state['host_diagnosis']['code'],flush=True)
            print('Fallback: use START_IN_AUTOCAD.cmd from a normal new AutoCAD session.',flush=True)
        write(run/'status.json',state);artifacts(run);return 0 if state['phase']=='PASSED' else 2
    except Exception as error:
        import traceback
        (run/'launcher_error.log').write_text(traceback.format_exc(),encoding='utf8')
        state.update(phase='FAILED',error=str(error));write(run/'status.json',state);artifacts(run);return 2


if __name__=='__main__':raise SystemExit(main())
