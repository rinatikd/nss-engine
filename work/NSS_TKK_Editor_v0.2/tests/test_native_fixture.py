import copy
import json
from pathlib import Path
import unittest

from tkk_editor_core import analyze


class NativeCaptureRegressionTests(unittest.TestCase):
    def test_snapshot_captured_from_reopened_native_dwg(self):
        root=Path(__file__).resolve().parents[1]
        data=json.loads((root/'evidence/native_fixture.json').read_text('utf8'))
        before=copy.deepcopy(data)
        result=analyze(data)
        self.assertEqual(data,before)
        self.assertEqual(len(result['leaders']),112)
        self.assertEqual(len(result['spans']),109)
        self.assertEqual({key:result['numbering'][key] for key in data['protected']},data['protected'])
        self.assertEqual(len(result['warnings']),29)
        self.assertTrue(all(0 < span['length_m'] <= 120+1e-8 for span in result['spans']))
        for key in ('text_route_collisions','text_well_collisions','text_caption_collisions','text_text_collisions'):
            self.assertEqual(result['layout_checks'][key],0)
