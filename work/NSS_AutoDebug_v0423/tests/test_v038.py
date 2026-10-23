import tempfile
import unittest
from pathlib import Path
from nss_engine.validation_v038 import audit

ROOT = Path(__file__).resolve().parents[1]

class PreflightV038Tests(unittest.TestCase):
    def test_current_sources_have_required_commands(self):
        self.assertTrue(audit(ROOT)['passed'], audit(ROOT))
    def test_detect_missing_commands(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d); (p/'autocad').mkdir(); (p/'autocad'/'NssEngine.Export.csproj').write_text('')
            self.assertTrue(audit(p)['missing_commands'])
    def test_detect_duplicate_commands(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d); (p/'autocad').mkdir(); (p/'autocad'/'NssEngine.Export.csproj').write_text('')
            for name in ['A.cs','B.cs']:
                (p/'autocad'/name).write_text('[CommandMethod("NSS_EXPORT_V033")]')
            self.assertIn('NSS_EXPORT_V033',audit(p)['duplicate_commands'])
    def test_missing_project_is_failure(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d); (p/'autocad').mkdir()
            self.assertFalse(audit(p)['passed'])
