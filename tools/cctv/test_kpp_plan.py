"""Синтетические проверки генератора плана КПП: без AutoCAD, без частных чертежей."""
import sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kpp_plan as k


def pairs(text):
    lines = text.splitlines()
    return [(lines[i].strip(), lines[i + 1].strip()) for i in range(0, len(lines) - 1, 2)]


class KppPlanTests(unittest.TestCase):
    def test_lane_geometry_matches_design(self):
        self.assertEqual(k.IN, (3.5, 7.0)); self.assertEqual(k.OUT, (8.5, 12.0)); self.assertEqual(k.ISL, (7.0, 8.5))
        for (a, b) in (k.IN, k.OUT): self.assertAlmostEqual(b - a, 3.5)
        self.assertAlmostEqual(k.ISL[1] - k.ISL[0], 1.5)

    def test_one_blocker_only_on_entry(self):
        blockers = [d for l, t, d in k.P if l == "СС-БЛОКЕР" and t == "rect"]
        self.assertEqual(len(blockers), 1)
        x0, y0, x1, y1, _ = blockers[0]
        self.assertTrue(y0 >= k.IN[0] and y1 <= k.IN[1], "блокер должен стоять на полосе въезда")

    def test_barriers_on_both_lanes(self):
        lines = [d for l, t, d in k.P if l == "СС-ШЛАГБАУМ" and t == "line"]
        self.assertEqual(len(lines), 2)

    def test_all_17_positions_unique(self):
        nums = sorted(d[2] for l, t, d in k.P if t == "badge")
        self.assertEqual(nums, list(range(1, 18)))

    def test_every_layer_has_colour(self):
        used = {l for l, _, _ in k.P}
        self.assertFalse(used - set(k.COL), used - set(k.COL))

    def test_dxf_is_wellformed_and_in_mm(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "kpp.dxf"; k.dxf(str(path))
            data = path.read_text(encoding="utf-8")
        pr = pairs(data)
        self.assertEqual(pr[-1], ("0", "EOF"))
        self.assertIn(("0", "ENDSEC"), pr)
        ents = [v for c, v in pr if c == "0"]
        for t in ("LINE", "CIRCLE", "ARC", "TEXT"): self.assertIn(t, ents)
        xs = [float(v) for c, v in pr if c == "10"]
        self.assertGreater(max(xs) - min(xs), 20000)       # метры -> мм
        self.assertLess(max(abs(x) for x in xs), 100000)

    def test_cli_no_png(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(k.main(["--out-dir", td, "--no-png"]), 0)
            self.assertTrue((Path(td) / "kpp_plan.dxf").is_file())
            self.assertFalse((Path(td) / "kpp_plan.png").exists())


if __name__ == "__main__":
    unittest.main()
