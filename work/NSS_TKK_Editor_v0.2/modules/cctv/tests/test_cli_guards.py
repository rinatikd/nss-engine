"""Subprocess regression tests: invalid CCTV CLI inputs never replace output DXF."""
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parents[1]
CLI = HERE / "cctv_cli.py"


class CliGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.plan = root / "plan.dxf"
        self.cameras = root / "cameras.csv"
        self.catalog = root / "catalog.csv"
        self.out = root / "result.dxf"
        self.plan.write_text("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", encoding="utf-8")
        self.cameras.write_text("name,x,y,rotation_deg,model,focal_mm,height_m,tilt_deg,bitrate_mbps\n", encoding="utf-8")
        self.catalog.write_text("model,focal_min,focal_max,sensor_w_mm,h_pixels,hfov_deg,dori_d_m,dori_o_m,dori_r_m,dori_i_m\n", encoding="utf-8")
        self.out.write_bytes(b"PREEXISTING_DXF_SENTINEL")

    def run_cli(self, *extra, out=None):
        result = subprocess.run(
            [sys.executable, str(CLI), str(self.plan), str(self.cameras),
             str(out or self.out), "--catalog", str(self.catalog), *extra],
            capture_output=True, text=True, timeout=15, check=False
        )
        return result

    def assert_preserved(self):
        self.assertEqual(self.out.read_bytes(), b"PREEXISTING_DXF_SENTINEL")

    def test_invalid_unit_is_rejected_before_writing(self):
        for value in ("0", "-1", "nan", "inf"):
            with self.subTest(value=value):
                p = self.run_cli("--unit", value)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn("--unit", p.stderr)
                self.assert_preserved()

    def test_invalid_retention_or_dori_level(self):
        for opts in (("--days", "0"), ("--days", "3651"), ("--level", "Unknown")):
            with self.subTest(options=opts):
                p = self.run_cli(*opts)
                self.assertNotEqual(p.returncode, 0)
                self.assert_preserved()

    def test_empty_camera_csv_never_replaces_dxf(self):
        p = self.run_cli()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("no camera rows", p.stderr)
        self.assert_preserved()

    def test_output_may_not_overwrite_plan(self):
        p = self.run_cli(out=self.plan)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("cannot overwrite", p.stderr)
        self.assertTrue(self.plan.read_text(encoding="utf-8").startswith("0\nSECTION"))
        self.assert_preserved()


if __name__ == "__main__":
    unittest.main()
