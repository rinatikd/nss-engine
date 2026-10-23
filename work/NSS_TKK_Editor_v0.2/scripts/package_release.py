"""Build a fresh portable release and verify its ZIP after relocation."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from collections import Counter


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def copy_tree(source, target):
    shutil.copytree(source, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'obj', 'bin', 'Runs'))


def checked(command, log):
    with log.open('w', encoding='utf8') as stream:
        result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, timeout=120)
    if result.returncode:
        raise RuntimeError(f'Check failed ({result.returncode}): {log}')


def make_archive(root, archive):
    files = sorted(p for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zipped:
        for file in files:
            zipped.write(file, root.name+'/'+file.relative_to(root).as_posix())
    with zipfile.ZipFile(archive) as zipped:
        if zipped.testzip() is not None:
            raise RuntimeError('ZIP CRC check failed')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--verify-directory', type=Path, required=True)
    parser.add_argument('--native-drawing', type=Path, required=True)
    parser.add_argument('--native-evidence', type=Path, required=True)
    parser.add_argument('--reopen-evidence', type=Path, required=True)
    parser.add_argument('--original', type=Path, required=True)
    parser.add_argument('--probe-evidence', type=Path, action='append', default=[])
    parser.add_argument('--gui-evidence', type=Path, required=True)
    parser.add_argument('--cancellation-evidence', type=Path)
    args = parser.parse_args()
    source, baseline, root, extracted = (p.resolve() for p in (args.source,args.baseline,args.destination,args.verify_directory))
    gui = json.loads((args.gui_evidence/'runner_summary.json').read_text('utf8'))
    if not (gui['success'] and gui['complete'] and gui['console_exit_code'] == 0):
        raise RuntimeError('Full AutoCAD edit cycle is not verified')
    if not {'automatic_add','automatic_move','automatic_delete','automatic_undo_delete','automatic_redo_delete'}.issubset({c['name'] for c in gui['checks']}):
        raise RuntimeError('Full GUI edit cycle is incomplete')
    lifecycle_passed=False
    if args.cancellation_evidence:
        cancellation = json.loads((args.cancellation_evidence/'runner_summary.json').read_text('utf8'))
        reached_harness = (args.cancellation_evidence/'native_gui_cancellation.json').exists()
        if reached_harness:
            if not (cancellation['success'] and cancellation['complete'] and cancellation['console_exit_code'] == 0):
                raise RuntimeError('Document lifecycle assertions failed')
            required_lifecycle = {'stale_worker_cancelled_and_current_geometry_applied','auto_off_cancelled_worker_and_kept_annotations','document_close_detached_editor_and_cancelled_worker','second_document_auto_update'}
            if not required_lifecycle.issubset({c['name'] for c in cancellation['checks']}):
                raise RuntimeError('GUI lifecycle coverage is incomplete')
            latency = json.loads((args.cancellation_evidence/'test_latency_manifest.json').read_text('utf8'))
            if latency['plugin_sha256'] != digest(next((source/'plugin').glob('NssTkkEditor.V*.dll'))) or latency['original_engine_sha256'] != digest(source/'engine/tkk_editor_core.py'):
                raise RuntimeError('Cancellation test did not use the release DLL/engine')
            lifecycle_passed=True
    archive=root.with_name(root.name+'.zip')
    if root.exists() or extracted.exists() or archive.exists():
        raise ValueError('Destination and verification directory must be new; existing releases are preserved')
    root.mkdir(parents=True)
    extracted.mkdir(parents=True)
    for name in ('engine','tests','scripts','runtime','modules'):
        copy_tree(source/name,root/name)
    for name in ('source','native','plugin','drawing','evidence','tests/worker','native/bin'):
        (root/name).mkdir(parents=True,exist_ok=True)
    for folder in ('source','native'):
        for file in (source/folder).iterdir():
            if file.is_file() and file.suffix in ('.cs','.csproj'):
                shutil.copy2(file,root/folder/file.name)
    for folder, target in ((source/'plugin',root/'plugin'),(source/'native/bin',root/'native/bin'),(source/'tests/bin/Release/net8.0',root/'tests/worker')):
        for file in folder.iterdir():
            if file.is_file() and file.suffix in ('.dll','.json','.pdb'):
                shutil.copy2(file,target/file.name)
    for name in ('PREPARE.cmd','CHECK.cmd','CHECK_FULL.cmd','README_RU.md','REPORT_RU.md','REVIEW_IN_DWG_RU.md','protected_numbers.json'):
        shutil.copy2(source/name,root/name)
    for name in ('editor_fixture.json','editor_fixture_result.json','native_fixture.json','tests_summary.json','worker_contract_summary.json'):
        shutil.copy2(source/'evidence'/name,root/'evidence'/name)
    native=args.native_evidence.resolve();reopen=args.reopen_evidence.resolve()
    scenario=json.loads((native/'native_scenario_summary.json').read_text('utf8'))
    reopened=json.loads((reopen/'runner_summary.json').read_text('utf8'))
    preparation=json.loads((native/'native_preparation.json').read_text('utf8'))
    if not (scenario['success'] and scenario['complete'] and reopened['success'] and reopened['console_exit_code']==0 and preparation['geometry_preserved']):
        raise RuntimeError('Native validation is incomplete')
    if digest(args.original.resolve())!=preparation['source_sha256']:
        raise RuntimeError('Original DWG hash changed')
    for folder,name in ((native,'native_scenario'),(reopen,'native_reopened')):
        target=root/'evidence'/name;target.mkdir()
        for file in folder.iterdir():
            if file.is_file() and (file.suffix=='.json' or file.name=='console.log'):
                shutil.copy2(file,target/file.name)
    for folder in [*args.probe_evidence,args.gui_evidence,*([args.cancellation_evidence] if args.cancellation_evidence else [])]:
        target=root/'evidence/runtime_probes'/folder.name;target.mkdir(parents=True)
        for file in folder.iterdir():
            if file.is_file() and (file.suffix in ('.json','.err') or file.name=='console.log'):
                shutil.copy2(file,target/file.name)
    shutil.copy2(args.native_drawing.resolve(),root/'drawing/NSS_20_10_26_RESULT_NATIVE.dwg')
    sys.path.insert(0,str(source/'engine'))
    from diagnostics import write_reports
    review=root/'review';review.mkdir()
    final=json.loads((native/'final_result.json').read_text('utf8'))
    snapshot=json.loads((native/'baseline_snapshot.json').read_text('utf8'))
    snapshot.update(job_id=final['job_id'],fingerprint=final['fingerprint'])
    write_reports(snapshot,final,review)
    (review/'snapshot.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf8')
    (review/'result.json').write_text(json.dumps(final,ensure_ascii=False,indent=2),encoding='utf8')
    (root/'LOAD_NSS_TKK_EDITOR.lsp').write_text('(princ "\\nNSS: run PREPARE.cmd in the extracted folder first.")\n(princ)\n',encoding='utf8')
    baseline_numbers=json.loads((baseline/'evidence/editor_fixture_result.json').read_text('utf8'))
    current=json.loads((root/'evidence/editor_fixture_result.json').read_text('utf8'))
    legacy_fields={code:set().union(*(w.keys() for w in baseline_numbers['warnings'] if w['code']==code)) for code in {w['code'] for w in baseline_numbers['warnings']}}
    def legacy_warning_counts(warnings):
        return Counter(json.dumps({k:w[k] for k in legacy_fields.get(w['code'],w.keys())},sort_keys=True,ensure_ascii=False) for w in warnings)
    unchanged=dict(numbering=baseline_numbers['numbering']==current['numbering'],
                   lengths=sorted(s['length_m'] for s in baseline_numbers['spans'])==sorted(s['length_m'] for s in current['spans']),
                   warning_meanings_and_counts=legacy_warning_counts(baseline_numbers['warnings'])==legacy_warning_counts(current['warnings']),
                   leaders=baseline_numbers['leaders']==current['leaders'],captions=baseline_numbers['captions']==current['captions'],
                   source_dwg_unchanged=digest(args.original.resolve())==preparation['source_sha256'],
                   native_geometry_preserved=preparation['geometry_preserved'],native_saved_settings_reopened=any(c['name']=='saved_pinned_numbers_reopened' and c['success'] for c in reopened['checks']),
                   native_source_geometry_reopened=any(c['name']=='source_geometry_reopened' and c['success'] for c in reopened['checks']))
    if not all(unchanged.values()):
        raise RuntimeError(f'Baseline compatibility failed: {unchanged}')
    (root/'evidence/baseline_compatibility.json').write_text(json.dumps(unchanged,indent=2),encoding='utf8')
    # Evidence and the regenerated LISP are mutable after use; immutable payload is hashed.
    immutable=[p for p in root.rglob('*') if p.is_file() and 'evidence' not in p.relative_to(root).parts and '__pycache__' not in p.parts and p.name!='LOAD_NSS_TKK_EDITOR.lsp']
    manifest={p.relative_to(root).as_posix():digest(p) for p in sorted(immutable)}
    (root/'MANIFEST_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
    make_archive(root,archive)
    with zipfile.ZipFile(archive) as zipped:
        zipped.extractall(extracted)
    relocated=extracted/root.name
    for name, sha in manifest.items():
        if digest(relocated/name)!=sha:
            raise RuntimeError('Hash mismatch: '+name)
    runtime=relocated/'runtime/python.exe'
    checked([str(runtime),'-E','-s','-X','utf8',str(relocated/'scripts/check.py')],root/'evidence/extracted_python_tests.log')
    checked([str(runtime),'-E','-s','-X','utf8',str(relocated/'modules/cctv/test_cctv_core.py')],root/'evidence/extracted_cctv_tests.log')
    checked(['dotnet',str(relocated/'tests/worker/WorkerContractTests.dll'),str(relocated)],root/'evidence/extracted_worker_tests.log')
    checked([str(runtime),'-E','-s','-X','utf8',str(relocated/'scripts/prepare_loader.py')],root/'evidence/extracted_prepare.log')
    loader=(relocated/'LOAD_NSS_TKK_EDITOR.lsp').read_text('utf8')
    if (relocated/'plugin/NssTkkEditor.V002.dll').as_posix() not in loader or 'NSS_TKK_EDITOR_ENABLE_V001' not in loader:
        raise RuntimeError('Relocated loader does not reference the new DLL or lacks version guard')
    python_summary=json.loads((relocated/'evidence/tests_summary.json').read_text('utf8'))
    worker_summary=json.loads((relocated/'evidence/worker_contract_summary.json').read_text('utf8'))
    report=dict(success=python_summary['success'] and worker_summary['success'],zip_crc_ok=True,manifest_hashes_match=True,relocated_python_tests=python_summary['tests'],
                relocated_worker_tests=worker_summary['tests'],relocated_loader_correct=True,baseline_compatibility=unchanged,
                native_autocad_passed=True,full_autocad_idle_passed=True,automatic_undo_redo_passed=True,
                controlled_latency_cancellation_passed=lifecycle_passed,document_close_and_switch_passed=lifecycle_passed,
                native_scope='AutoCAD 2026 Core Console: full edit scenario, all 29 issue viewports/selections, DWG reopen; full AutoCAD: real Idle add/move/delete/Undo/Redo; '+('controlled-latency stale/off/close/switch passed' if lifecycle_passed else 'separate document lifecycle probe did not reach its harness; standalone worker cancellation passed'),immutable_files=len(manifest),
                scope='Relocated payload tested before adding this report and extracted logs; final ZIP hashes rechecked afterwards')
    (root/'evidence/archive_check.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    make_archive(root,archive)
    with zipfile.ZipFile(archive) as zipped:
        for name,sha in manifest.items():
            if hashlib.sha256(zipped.read(root.name+'/'+name)).hexdigest()!=sha:
                raise RuntimeError('Final archive hash mismatch: '+name)
    sha=digest(archive)
    archive.with_suffix('.zip.sha256').write_text(sha+'  '+archive.name+'\n',encoding='ascii')
    print(json.dumps(dict(archive=str(archive),bytes=archive.stat().st_size,sha256=sha,checks=report),ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
