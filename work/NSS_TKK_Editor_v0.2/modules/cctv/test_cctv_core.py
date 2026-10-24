import math, os, tempfile, unittest, sys, subprocess
from unittest.mock import patch
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

    def test_collinear_wall_occludes_center_ray(self):
        # A wall along the view axis must not produce a full-range spike.
        for wall in (((5, 0), (10, 0)), ((10, 0), (5, 0))):
            with self.subTest(wall=wall):
                poly = c.visibility_polygon((0, 0), 0, 90, 20, [wall], rays=10)
                self.assertEqual(poly[6], (5.0, 0.0))

    def test_parallel_ray_intersections(self):
        # Intersection parameters also support non-unit ray directions.
        self.assertEqual(c._ray_segment((1, 2), (2, 0), (11, 2), (5, 2)), 2.0)
        self.assertEqual(c._ray_segment((1, 2), (2, 0), (-1, 2), (5, 2)), 0.0)
        self.assertIsNone(c._ray_segment((1, 2), (2, 0), (5, 3), (11, 3)))
        self.assertIsNone(c._ray_segment((1, 2), (2, 0), (-5, 2), (-1, 2)))
        self.assertIsNone(c._ray_segment((1, 2), (0, 0), (5, 2), (11, 2)))

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


    def test_save_uses_bounded_temp_prefix_for_long_destination_name(self):
        with tempfile.TemporaryDirectory() as d:
            basename = "x" * 239 + ".dxf"
            output = os.path.join(d, basename)
            writer = c.DxfWriter()
            real_named_temporary_file = c.tempfile.NamedTemporaryFile
            prefixes = []

            def capture_temp_file(*args, **kwargs):
                prefixes.append(kwargs["prefix"])
                return real_named_temporary_file(*args, **kwargs)

            def simulate_replace(source, destination):
                self.assertEqual(os.path.basename(destination), basename)
                os.unlink(source)

            with patch.object(c.tempfile, "NamedTemporaryFile", side_effect=capture_temp_file):
                with patch.object(c.os, "replace", side_effect=simulate_replace):
                    writer.save(output)

            self.assertEqual(prefixes, ["nss-cctv-"])
            self.assertEqual(os.listdir(d), [])

    def _assert_save_failure_is_safe(self, existing_output):
        with tempfile.TemporaryDirectory() as d:
            output = os.path.join(d, "result.dxf")
            sentinel = b"previous valid drawing\x00"
            if existing_output:
                with open(output, "wb") as f:
                    f.write(sentinel)

            writer = c.DxfWriter()
            real_named_temporary_file = c.tempfile.NamedTemporaryFile

            class PartialWriteFailure:
                def __init__(self, stream):
                    self.stream = stream

                @property
                def name(self):
                    return self.stream.name

                def __enter__(self):
                    self.stream.__enter__()
                    return self

                def __exit__(self, *args):
                    return self.stream.__exit__(*args)

                def write(self, content):
                    self.stream.write(content[:16])
                    raise OSError("simulated disk write failure")

            def make_failing_temp_file(*args, **kwargs):
                return PartialWriteFailure(real_named_temporary_file(*args, **kwargs))

            with patch.object(c.tempfile, "NamedTemporaryFile", side_effect=make_failing_temp_file):
                with self.assertRaisesRegex(OSError, "simulated disk write failure"):
                    writer.save(output)

            if existing_output:
                with open(output, "rb") as f:
                    self.assertEqual(f.read(), sentinel)
                self.assertEqual(os.listdir(d), ["result.dxf"])
            else:
                self.assertFalse(os.path.exists(output))
                self.assertEqual(os.listdir(d), [])

    def test_save_failure_preserves_existing_destination(self):
        self._assert_save_failure_is_safe(existing_output=True)

    def test_save_failure_does_not_publish_partial_new_destination(self):
        self._assert_save_failure_is_safe(existing_output=False)


if __name__ == "__main__":
    unittest.main()
