import importlib.util
from pathlib import Path
import tempfile
import unittest
from nss_engine.host_diagnostics_v0422 import diagnose,decode_host_log

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('autodebug_bootstrap_tests',ROOT/'scripts/autodebug_v0421.py')
debug=importlib.util.module_from_spec(spec);spec.loader.exec_module(debug)


class HostDiagnosticsTests(unittest.TestCase):
    def test_temp_error_is_not_a_dll_verdict(self):
        r=diagnose(b'System exception: Cannot get temporary directory long path name',3221225477)
        self.assertEqual(r['code'],'HOST_TEMP_DIRECTORY_ERROR')
        self.assertFalse(r['plugin_failure_confirmed']);self.assertEqual(r['fallback'],'RUN_IN_AUTOCAD.lsp')

    def test_profile_error_utf16_bom(self):
        r=diagnose('Problem with setting up current profile.'.encode('utf-16'),1)
        self.assertEqual(r['code'],'HOST_PROFILE_SETUP_ERROR')

    def test_utf16_without_bom_and_unicode(self):
        text='Ошибка запуска: Problem with setting up current profile.'
        self.assertEqual(decode_host_log(text.encode('utf-16-le')),text)

    def test_empty_pending_and_unknown_exit(self):
        self.assertEqual(diagnose(b'')['code'],'NATIVE_REPORT_NOT_YET_AVAILABLE')
        self.assertEqual(diagnose(b'',1)['code'],'HOST_EXITED_BEFORE_NATIVE_REPORT')

    def test_native_report_does_not_mean_success(self):
        r=diagnose(b'',0,True)
        self.assertEqual(r['code'],'NATIVE_REPORT_AVAILABLE');self.assertFalse(r['plugin_failure_confirmed'])
        self.assertIsNone(r['fallback'])

    def test_log_excerpt_bounded(self):
        self.assertLessEqual(len(diagnose(b'a'*10000,1)['host_log_excerpt']),4000)


class InHostBootstrapTests(unittest.TestCase):
    def test_unicode_and_spaces_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            run=Path(tmp)/'Путь с пробелами';run.mkdir()
            state=dict(run_id='a'*32,fixture=str(run/'fixture_copy.dxf'),dll=str(run/'plugin.dll'))
            loader=debug.make_in_host_bootstrap(run,state)
            self.assertTrue(loader.read_bytes().startswith(b'\xef\xbb\xbf'))
            script=(run/'in_host.scr').read_text(encoding='utf8')
            self.assertIn('_.OPEN\n',script);self.assertIn('invoke.lsp',script)
            self.assertIn('Путь с пробелами',script)
            invoke=(run/'reports/invoke.lsp').read_text(encoding='utf-8-sig')
            self.assertIn('authorization.json',invoke);self.assertIn('NSS_AUTOTEST_FILE_V0423_PREBUILT',invoke)
            for forbidden in ('setenv','setvar','_.SAVE','_.QUIT','_.CLOSE','SECURELOAD'):
                self.assertNotIn(forbidden,script)
            self.assertIn('_.SCRIPT',loader.read_text(encoding='utf-8-sig'))

    def test_path_quoting(self):
        self.assertEqual(debug.lisp_string('C:\\a b\\test.dxf'),'"C:/a b/test.dxf"')
        self.assertEqual(debug.lisp_string('a"b'),'"a\\"b"')

    def test_already_open_fixture_does_not_receive_open_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            run=Path(tmp)
            loader=debug.make_in_host_bootstrap(run,dict(run_id='b'*32,fixture=str(run/'fixture_copy.dxf'),dll=str(run/'plugin.dll')))
            text=loader.read_text(encoding='utf-8-sig')
            self.assertIn('(strcat (getvar "DWGPREFIX") (getvar "DWGNAME"))',text)
            active=text.split('(if (= (strcase nss-current) (strcase nss-fixture))',1)[1].split('(progn',1)[0]
            self.assertIn('(load ',active)
            self.assertNotIn('SCRIPT',active)
            self.assertIn('vla-get-Documents',text)
            self.assertIn('(if nss-open',text)
            self.assertIn('already open fixture_copy.dxf tab',text)
