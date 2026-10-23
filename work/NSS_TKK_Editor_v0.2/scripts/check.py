from pathlib import Path
import sys,unittest,json
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'engine'))
suite=unittest.defaultTestLoader.discover(str(root/'tests'),pattern='test_*.py')
result=unittest.TextTestRunner(stream=sys.stdout,verbosity=2).run(suite)
(root/'evidence/tests_summary.json').write_text(json.dumps(dict(tests=result.testsRun,failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped),success=result.wasSuccessful()),indent=2),encoding='utf8')
if result.wasSuccessful():
 from tkk_editor_core import analyze
 data=json.loads((root/'evidence/editor_fixture.json').read_text('utf8'));r=analyze(data)
 (root/'evidence/editor_fixture_result.json').write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf8')
 print('Real drawing snapshot:',r['phase'],len(r['leaders']),'wells,',len(r['spans']),'spans,',len(r['warnings']),'warnings')
sys.exit(0 if result.wasSuccessful() else 1)
