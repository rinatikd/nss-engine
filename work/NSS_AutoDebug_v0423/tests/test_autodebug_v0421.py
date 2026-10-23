import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from nss_engine.dxf_audit_v042 import convert
from ezdxf.addons import iterdxf

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('autodebug',ROOT/'scripts/autodebug_v0421.py')
debug=importlib.util.module_from_spec(spec);spec.loader.exec_module(debug)


class AutoDebugCollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.run=Path(self.temp.name);self.reports=self.run/'reports';self.reports.mkdir()
        self.dll=self.run/'plugin.dll';self.dll.write_bytes(b'synthetic DLL for collector unit tests, NOT a native run')
        self.source=self.run/'fixture_copy.dxf';debug.fixture(self.source)
        self.state=dict(run_id=uuid.uuid4().hex,dll=str(self.dll),dll_sha256=debug.sha(self.dll),fixture=str(self.source),fixture_sha256=debug.sha(self.source))
        debug.write(self.run/'status.json',self.state)
        reader=iterdxf.opendxf(self.source);entities=[]
        try:
            for e in reader.modelspace():
                if e.dxftype()!='CIRCLE':entities.append(convert(e))
        finally:reader.close()
        self.snapshot=dict(schema_version='0.42',kind='snapshot3d',producer='AutoCAD',drawing=dict(id='synthetic-test-id',name=self.source.name,insunits_code=6,coordinate_system='unverified'),
                           host=dict(assembly_version='0.42.3.0',dbmod_before=16,dbmod_after=16),coverage=dict(visited=9,exported=8,skipped=1,truncated=False,complete=False),entities=entities,warnings=[])
        self.snap_path=self.reports/'snapshot_v042_synthetic_unit_test.json';debug.write(self.snap_path,self.snapshot)
        debug.write(self.reports/'runtime_validation_v041.json',dict(schema_version='0.41',drawing_name=self.source.name,drawing_id='synthetic-test-id',insunits='Meters',counts=dict(lines=5,polylines=2,blocks=1,other=1,failed=0)))
        self.job=self.reports/'analysis_test';self.job.mkdir()
        self.native=dict(schema_version='0.42.3',run_id=self.state['run_id'],phase='NATIVE_CHECKS_PASSED_WAITING_FOR_PYTHON',assembly_version='0.42.3.0',dll_sha256=self.state['dll_sha256'],source_sha256=self.state['fixture_sha256'],failures=0,
                         cases=[dict(name=name,passed=True) for name in sorted(debug.CASES)],python_job=str(self.job),preview_test_scope='private_disposable_database_only')
        self.native_path=self.reports/'native_results.json';debug.write(self.native_path,self.native)
        from nss_engine.pipeline_v042 import analyze_entities
        analysis=analyze_entities(entities);analysis['drawing']=self.snapshot['drawing'];analysis['source_coverage']=self.snapshot['coverage']
        debug.write(self.job/'analysis_v042.json',analysis)
        debug.write(self.job/'status.json',dict(phase='COMPLETED_REVIEW_REQUIRED',snapshot_sha256=debug.sha(self.snap_path)))

    def test_valid_fixture_pipeline_and_all_native_cases(self):
        result=debug.collect(self.run)
        self.assertEqual(result['native_cases'],15)
        self.assertEqual(result['topology']['segments'],3)

    def test_missing_native_is_pending_not_passed(self):
        self.native_path.unlink();self.assertIsNone(debug.collect(self.run))

    def test_bootstrap_error_is_terminal_not_ten_minute_wait(self):
        self.native_path.unlink()
        debug.write(self.reports/'bootstrap_error.json',dict(run_id=self.state['run_id'],code='ASSEMBLY_OR_ENTRY_NOT_LOADED'))
        with self.assertRaisesRegex(ValueError,'BOOTSTRAP_FAILED'):debug.collect(self.run)

    def test_stale_bootstrap_error_rejected(self):
        debug.write(self.reports/'bootstrap_error.json',dict(run_id='old',code='ASSEMBLY_OR_ENTRY_NOT_LOADED'))
        with self.assertRaisesRegex(ValueError,'stale bootstrap'):debug.collect(self.run)

    def test_python_running_is_pending(self):
        debug.write(self.job/'status.json',dict(phase='RUNNING'));self.assertIsNone(debug.collect(self.run))

    def test_stale_run_id_rejected(self):
        self.native['run_id']='old';debug.write(self.native_path,self.native)
        with self.assertRaisesRegex(ValueError,'run id'):debug.collect(self.run)

    def test_wrong_native_version_and_hash_rejected(self):
        for key,value in (('assembly_version','0.42.0.0'),('dll_sha256','wrong')):
            n=copy.deepcopy(self.native);n[key]=value;debug.write(self.native_path,n)
            with self.assertRaises(ValueError):debug.collect(self.run)

    def test_missing_and_duplicate_native_case_rejected(self):
        for cases in (self.native['cases'][:-1],self.native['cases'][:-1]+self.native['cases'][:1]):
            n=copy.deepcopy(self.native);n['cases']=cases;debug.write(self.native_path,n)
            with self.assertRaisesRegex(ValueError,'native checks'):debug.collect(self.run)

    def test_native_failure_cannot_be_hidden_by_zero_count(self):
        self.native['cases'][0]['passed']=False;debug.write(self.native_path,self.native)
        with self.assertRaisesRegex(ValueError,'native test failure'):debug.collect(self.run)

    def test_python_failure_rejected(self):
        debug.write(self.job/'status.json',dict(phase='FAILED',message='example'))
        with self.assertRaisesRegex(ValueError,'Python analysis failed'):debug.collect(self.run)

    def test_python_job_path_outside_run_rejected(self):
        self.native['python_job']=str(self.run/'outside');debug.write(self.native_path,self.native)
        with self.assertRaisesRegex(ValueError,'escaped'):debug.collect(self.run)

    def test_changed_input_or_DLL_rejected(self):
        self.dll.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'changed'):debug.collect(self.run)

    def test_changed_dbmod_rejected(self):
        self.snapshot['host']['dbmod_after']=17;debug.write(self.snap_path,self.snapshot)
        with self.assertRaisesRegex(ValueError,'DBMOD'):debug.collect(self.run)

    def test_wrong_python_snapshot_rejected(self):
        debug.write(self.job/'status.json',dict(phase='COMPLETED_REVIEW_REQUIRED',snapshot_sha256='old'))
        with self.assertRaisesRegex(ValueError,'different snapshot'):debug.collect(self.run)

    def test_wrong_topology_rejected(self):
        analysis=debug.read(self.job/'analysis_v042.json');analysis['screening']['summary']['components']=2
        debug.write(self.job/'analysis_v042.json',analysis)
        with self.assertRaisesRegex(ValueError,'topology'):debug.collect(self.run)

    def test_truncation_rejected(self):
        self.snapshot['coverage']['truncated']=True;debug.write(self.snap_path,self.snapshot)
        with self.assertRaisesRegex(ValueError,'coverage'):debug.collect(self.run)

    def test_bundle_and_HTML_are_created_on_failure(self):
        self.state['phase']='FAILED';self.state['error']='<script>test</script>';debug.write(self.run/'status.json',self.state)
        debug.artifacts(self.run)
        self.assertNotIn('<script>',(self.run/'RESULT.html').read_text(encoding='utf8'))
        self.assertTrue((self.run.parent/(self.run.name+'_diagnostics.zip')).exists())
        # artifact is adjacent to TemporaryDirectory, remove only this known file
        (self.run.parent/(self.run.name+'_diagnostics.zip')).unlink()
