import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('loader_isolation',ROOT/'scripts/autodebug_v0421.py')
debug=importlib.util.module_from_spec(spec);spec.loader.exec_module(debug)


class LoaderIsolationTests(unittest.TestCase):
    def test_different_runs_have_different_assemblies_and_entries(self):
        a=debug.registration('a'*32);b=debug.registration('b'*32)
        for field in ('assembly','entry','command'):self.assertNotEqual(a[field],b[field])
        self.assertNotEqual(a['assembly'],'NssEngine.Export')
        self.assertEqual(a['entry'],a['entry'].upper())

    def test_registration_rejects_code_injection(self):
        for bad in ('','a'*31,'G'*32,'../evil','a'*31+';'):
            with self.assertRaises(ValueError):debug.registration(bad)

    def test_bootstrap_guards_reload_and_catches_missing_function(self):
        with tempfile.TemporaryDirectory() as temp:
            run=Path(temp);(run/'reports').mkdir()
            state=dict(run_id='a'*32,dll=str(run/'unique.dll'),entry_name=debug.registration('a'*32)['entry'])
            file=debug.make_invoker(run,state);text=file.read_text(encoding='utf-8-sig')
            self.assertIn('atoms-family',text)
            self.assertIn('vl-catch-all-apply',text)
            self.assertNotIn("vl-catch-all-apply 'command",text)
            self.assertNotIn('vl-catch-all-apply (read ',text)
            self.assertIn("vl-catch-all-apply '(lambda () (command-s",text)
            self.assertIn("'(lambda () ("+state['entry_name']+' ',text)
            self.assertIn('ASSEMBLY_OR_ENTRY_NOT_LOADED',text)
            self.assertIn('bootstrap_error.json',text)
            self.assertNotIn('NSS_AUTOTEST_FILE_V042"',text)
            # Check generated Lisp delimiters while respecting escaped strings.
            depth=0;inside=False;escape=False
            for c in text:
                if inside:
                    if escape:escape=False
                    elif c=='\\':escape=True
                    elif c=='"':inside=False
                elif c=='"':inside=True
                elif c=='(':depth+=1
                elif c==')':
                    depth-=1;self.assertGreaterEqual(depth,0)
            self.assertFalse(inside);self.assertEqual(depth,0)
