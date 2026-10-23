import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tkk_editor_core import analyze
from test_editor_core import fixture


class SnapshotBoundaryTests(unittest.TestCase):
    def test_invalid_numbers_rejected_before_layout(self):
        for number in (0, -1, True, 1.5, "1"):
            with self.subTest(number=number):
                data = fixture()
                data["protected"]["A"] = number
                with self.assertRaisesRegex(ValueError, "positive integer"):
                    analyze(data)

    def test_duplicate_reserved_numbers_rejected(self):
        data = fixture()
        data["protected"]["deleted"] = 1
        with self.assertRaisesRegex(ValueError, "Duplicate protected number"):
            analyze(data)

    def test_nonfinite_coordinates_rejected(self):
        for value in (float("nan"), float("inf"), -float("inf"), True, "0"):
            with self.subTest(value=value):
                data = fixture()
                data["routes"][0]["points"][0][0] = value
                with self.assertRaisesRegex(ValueError, "finite numbers"):
                    analyze(data)

    def test_zero_length_and_malformed_route_rejected(self):
        for points in ([[0, 0, 0]], [[0, 0], [0, 0]], [[0, 0], [1]]):
            data = fixture()
            data["routes"][0]["points"] = points
            with self.subTest(points=points), self.assertRaises(ValueError):
                analyze(data)

    def test_duplicate_route_and_reserved_identity_rejected(self):
        data = fixture()
        data["routes"].append(copy.deepcopy(data["routes"][0]))
        with self.assertRaisesRegex(ValueError, "Duplicate routes"):
            analyze(data)
        data = fixture()
        data["wells"][0]["id"] = "END:3"
        with self.assertRaisesRegex(ValueError, "reserved identity"):
            analyze(data)

    def test_ambiguous_station_cannot_silently_pick_one_well(self):
        data = fixture()
        data["wells"].append(dict(id="D", xyz=[60, .5, 0]))
        with self.assertRaisesRegex(ValueError, "Ambiguous connection.*B.*D"):
            analyze(data)

    def test_enumeration_order_does_not_change_numbers_or_annotations(self):
        data = fixture()
        data["wells"].append(dict(id="D", xyz=[60, 50, 0]))
        data["routes"].append(dict(id="branch", points=[[60, 0, 0], [60, 50, 0]]))
        before = analyze(data)
        data["wells"].reverse()
        data["routes"].reverse()
        self.assertEqual(before, analyze(data))

    def test_self_returning_loop_has_warning_and_no_fake_span(self):
        data = dict(wells=[dict(id="A", xyz=[0, 0, 0])], routes=[dict(id="r", points=[[0, 0], [30, 0], [30, 30], [0, 0]])])
        result = analyze(data)
        self.assertEqual(result["spans"], [])
        self.assertIn("SELF_RETURNING_SPAN", [w["code"] for w in result["warnings"]])

    def test_failed_worker_writes_atomic_error_result(self):
        with tempfile.TemporaryDirectory() as temp:
            source, target = Path(temp)/"input.json", Path(temp)/"result.json"
            data = fixture()
            data["protected"] = {"A": 0}
            source.write_text(json.dumps(data), encoding="utf8")
            script = Path(__file__).resolve().parents[1]/"engine/tkk_editor_core.py"
            process = subprocess.run([sys.executable, str(script), str(source), str(target)], capture_output=True, timeout=30)
            result = json.loads(target.read_text("utf8"))
            self.assertEqual(result["phase"], "FAILED")
            self.assertIn("positive integer", result["error"])
            self.assertFalse(target.with_suffix(".tmp").exists())
