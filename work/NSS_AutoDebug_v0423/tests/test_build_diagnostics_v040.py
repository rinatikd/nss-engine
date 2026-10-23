import unittest
from nss_engine.build_diagnostics_v040 import analyze
class BuildDiagnosticsTests(unittest.TestCase):
    def test_compiler(self):
        self.assertEqual(analyze('Program.cs(2,1): error CS1002: ; expected')['issues'][0]['category'],'CS_COMPILER')
    def test_reference(self):
        self.assertEqual(analyze('warning MSB3245: Could not resolve this reference')['issues'][0]['category'],'AUTOCAD_REFERENCE')
    def test_sdk(self):
        self.assertEqual(analyze('error NETSDK1045: SDK not found')['issues'][0]['category'],'SDK_MISSING')
    def test_nuget(self):
        self.assertEqual(analyze('error NU1101: Unable to find package')['issues'][0]['category'],'RESTORE')
    def test_no_errors_not_success(self):
        result=analyze('Build succeeded.')
        self.assertEqual(result['issue_count'],0)
        self.assertFalse(result['build_success_confirmed'])
    def test_line_number(self):
        self.assertEqual(analyze('hello\nerror MSB1009: Project file does not exist')['issues'][0]['line'],2)
