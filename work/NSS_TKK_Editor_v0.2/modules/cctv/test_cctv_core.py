import math, os, tempfile, unittest, sys, subprocess
sys.path.insert(0, os.path.dirname(__file__))
import cctv_core as c


class T(unittest.TestCase):
    def test_hfov(self):
        self.assertAlmostEqual(c.Lens(6.4, 1920, 3.2).hfov_deg, 90.0, places=6)

    def test_ppm(self):
        self.assertAlmostEqual(c.ppm_at(c.Lens(6.4, 1920, 3.2), 10), 96.0, places=6)

    def test_dori_distance_consistent(self):
        l = c.Lens(6.4, 1920, 3.2)
        d = c.dori_distances_m(l)
        for n, t in c.DORI.items():
            self.assertAlmostEqual(c.ppm_at(l, d[n]), t, places=6)

    def test_wall_occlusion(self):
        wall = ((5, -100), (5, 100))
        poly = c.visibility_polygon((0, 0), 0, 90, 20, [wall], rays=10)
        mid = poly[1 + 5]
        self.assertAlmostEqual(mid[0], 5.0, places=6)
        self.assertTrue(all(p[0] <= 5.0001 for p in poly))

    def test_no_wall_full_range(self):
        poly = c.visibility_polygon((0, 0), 0, 90, 20, [], rays=10)
        self.assertAlmostEqual(math.hypot(*poly[6]), 20, places=6)

    def test_storage(self):
        self.assertAlmostEqual(c.storage_tb_per_day(4), 0.0432, places=6)
        cams = [c.Camera(f"C{i}", 0, 0, 0, c.Lens(6.4, 1920, 3.2), bitrate_mbps=4) for i in range(16)]
        self.assertAlmostEqual(c.storage_total_tb(cams, 30), 20.736, places=6)

    def test_dxf_roundtrip(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "o.dxf")
        cam = c.Camera("C1", 1000, 1000, 0, c.Lens(6.4, 1920, 3.2), model="X")
        walls = [((6000, -5000), (6000, 8000))]
        c.build_drawing([cam], walls, p)
        got = c.read_walls(p, ["WALLS_REF"])
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0], ((6000.0, -5000.0), (6000.0, 8000.0)))
        self.assertEqual(c.read_walls(p, ["CCTV_FOV"]), [(a, b) for a, b in c.read_walls(p, ["CCTV_FOV"])])
        self.assertGreater(len(c.read_walls(p, ["CCTV_FOV"])), 50)

    def test_lwpolyline(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "l.dxf")
        with open(p, "w", encoding="utf-8") as f:
            f.write("0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\nA-WALL\n70\n1\n"
                    "10\n0\n20\n0\n10\n10\n20\n0\n10\n10\n20\n10\n0\nENDSEC\n0\nEOF\n")
        self.assertEqual(len(c.read_walls(p, ["a-wall"])), 3)

    def test_cli_end_to_end(self):
        with tempfile.TemporaryDirectory() as d:
            plan = os.path.join(d, "plan.dxf")
            cameras = os.path.join(d, "cameras.csv")
            output = os.path.join(d, "result.dxf")
            with open(plan, "w", encoding="ascii") as f:
                f.write("0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nA-WALL\n10\n6000\n20\n-5000\n11\n6000\n21\n8000\n0\nENDSEC\n0\nEOF\n")
            with open(cameras, "w", encoding="utf-8", newline="") as f:
                f.write("name,x,y,rotation_deg,model,focal_mm,height_m,tilt_deg,bitrate_mbps\n")
                f.write("ВН-1.1,1000,1000,0,DS-2CD1143G2-I,2.8,3,0,0.72\n")
            completed = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(__file__), "cctv_cli.py"),
                 plan, cameras, output, "--layers", "A-WALL", "--days", "30", "--level", "Observe"],
                check=True, capture_output=True, text=True, encoding="utf-8",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            self.assertTrue(os.path.isfile(output))
            self.assertIn("Архив 30 сут", completed.stdout)
            self.assertIn("'Observe, м': 23.0", completed.stdout)
            self.assertGreater(len(c.read_walls(output, ["CCTV_FOV"])), 10)
            with open(output, encoding="utf-8") as f:
                result_dxf = f.read()
            self.assertIn("99.0\n2\nHFOV_DEG", result_dxf)


if __name__ == "__main__":
    unittest.main()
