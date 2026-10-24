#!/usr/bin/env python3
"""Run portable synthetic-data tests; never require private drawings or start Autodesk."""
from pathlib import Path
import os,subprocess,sys,unittest
ROOT=Path(__file__).resolve().parents[1]
PRIVATE_TESTS={'test_diagnostics.DiagnosticsTests.test_native_fixture_all_29_issues_are_located_without_changing_spans'}

def flatten(suite):
    for item in suite:
        if isinstance(item,unittest.TestSuite):yield from flatten(item)
        else:yield item

def worker(modules):
    suite=unittest.TestSuite()
    for case in flatten(unittest.defaultTestLoader.loadTestsFromNames(modules)):
        if case.id() in PRIVATE_TESTS:print('Omitted private-data test: '+case.id())
        else:suite.addTest(case)
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1

def main():
    if len(sys.argv)>1 and sys.argv[1]=='--worker':return worker(sys.argv[2:])
    tkk=ROOT/'work/NSS_TKK_Editor_v0.2'
    checks=[
      (tkk/'tests',[str(tkk/'engine')],['test_editor_core','test_equal_spacing','test_diagnostics','test_fes_numbering','test_span_labels','test_snapshot_validation']),
      (tkk/'modules/cctv',[],['test_cctv_core']),
      (ROOT/'work/NSS_AutoDebug_v0423/tests',[str(ROOT/'work/NSS_AutoDebug_v0423')],['test_analyzer','test_v022','test_v023']),
      (ROOT/'tools/tests',[str(ROOT),str(ROOT/'tools')],['test_repo_guard','test_tkk_integrity','test_thermal_visibility']),
    ]
    for cwd,paths,modules in checks:
        if not all((cwd/(m+'.py')).is_file() for m in modules):raise RuntimeError('A required tracked test module is missing: '+str(cwd))
        env=os.environ.copy();env['PYTHONPATH']=os.pathsep.join([str(cwd)]+paths+([env['PYTHONPATH']] if env.get('PYTHONPATH') else []));env['PYTHONDONTWRITEBYTECODE']='1'
        result=subprocess.run([sys.executable,str(Path(__file__).resolve()),'--worker']+modules,cwd=cwd,env=env)
        if result.returncode:return result.returncode
    print('Portable synthetic-data checks passed. Native host and private-fixture tests were not run.');return 0
if __name__=='__main__':raise SystemExit(main())
