import math, os, tempfile, unittest, sys, subprocess
from unittest.mock import patch
sys.path.insert(0, os.path.dirname(__file__))
import cctv_core as c


class T(unittest.TestCase):
    def test_rejects_nonfinite_camera_before_replacing_output(self):
        with tempfile.TemporaryDirectory() as d:
            output = os.path.join(d, "result.dxf")
            with open(output, "wb") as f:
                f.write(b"previous drawing")
            with self.assertRaises(ValueError):
                c.build_drawing([c.Camera("C1", float("nan"), 0, 0,
                                          c.Lens(6.4, 1920, 3.2))], [], output)
            with open(output, "rb") as f:
                self.assertEqual(f.read(), b"previous drawing")

    def test_generated_r12_is_ascii_with_unicode_text_escapes(self):
        with tempfile.TemporaryDirectory() as d:
            output = os.path.join(d, "result.dxf")
            c.build_drawing([c.Camera("ВН-1", 0, 0, 0, c.Lens(6.4, 1920, 3.2))], [], output)
            with open(output, "rb") as f:
                content = f.read()
            self.assertTrue(content.isascii())
            self.assertIn(b"\\U+0412\\U+041D-1", content)

    def test_annotation_size_tracks_drawing_units(self):
        with tempfile.TemporaryDirectory() as d:
            output = os.path.join(d, "result.dxf")
            c.build_drawing([c.Camera("C1", 0, 0, 0, c.Lens(6.4, 1920, 3.2))], [], output, unit_scale=1)
            pairs = list(c._pairs(output))
            text = pairs[pairs.index((0, "TEXT")) + 1:]
            self.assertEqual(next(v for k, v in text if k == 40), "0.25")
            self.assertEqual(next(v for k, v in text if k == 20), "0.4")

    def test_independent_dxf_reader_preserves_labels_geometry_and_attributes(self):
        try:
            import ezdxf
            from ezdxf.lldxf.encoding import decode_dxf_unicode
        except ImportError:
            self.skipTest("Independent DXF check requires optional ezdxf")
        with tempfile.TemporaryDirectory() as d:
            output = os.path.join(d, "result.dxf")
            camera = c.Camera("ВН-1", 1, 2, 0, c.Lens(6.4, 1920, 3.2), model="Модель")
            c.build_drawing([camera], [((6, -20), (6, 20))], output, unit_scale=1)
            doc = ezdxf.readfile(output)
            auditor = doc.audit()
            self.assertFalse(auditor.errors)
            self.assertFalse(auditor.fixes)
            space = doc.modelspace()
            text = list(space.query("TEXT"))[0]
            self.assertIn("ВН-1", decode_dxf_unicode(text.dxf.text))
            self.assertAlmostEqual(text.dxf.height, 0.25)
            self.assertAlmostEqual(text.dxf.insert.y, 2.4)
            insert = list(space.query("INSERT"))[0]
            self.assertEqual(decode_dxf_unicode(insert.get_attrib_text("MODEL")), "Модель")
            self.assertEqual(tuple(insert.dxf.insert), (1, 2, 0))
            fov = [e for e in space.query("POLYLINE") if e.dxf.layer == "CCTV_FOV"][0]
            self.assertTrue(fov.is_closed)
            self.assertTrue(all(v.dxf.location.x <= 6.000001 for v in fov.vertices))

    def test_cli_invalid_input_preserves_existing_drawing_even_optimized(self):
        with tempfile.TemporaryDirectory() as d:
            plan = os.path.join(d, "plan.dxf")
            cameras = os.path.join(d, "cameras.csv")
            output = os.path.join(d, "result.dxf")
            writer = c.DxfWriter()
            writer.save(plan)
            with open(plan, "rb") as f:
                original_plan = f.read()
            header = "name,x,y,rotation_deg,model,focal_mm,height_m,tilt_deg,bitrate_mbps\n"
            valid = "C1,0,0,0,DS-2CD1143G2-I,2.8,3,0,4\n"
            cases = [(header, []), (header + valid.replace(",2.8,", ",9,"), []),
                     (header + valid.replace("C1,0,", "C1,nan,"), []),
                     (header + valid, ["--unit", "-1"]),
                     (header + valid, ["--days", "0"]),
                     (header + valid, ["--level", "Other"]),
                     (header + valid, ["--xlsx", output])]
            for content, args in cases:
                for optimized in (False, True):
                    with self.subTest(content=content, args=args, optimized=optimized):
                        with open(cameras, "w", encoding="utf-8") as f:
                            f.write(content)
                        with open(output, "wb") as f:
                            f.write(b"existing drawing")
                        result = subprocess.run([sys.executable] + (["-O"] if optimized else []) +
                            [os.path.join(os.path.dirname(__file__), "cctv_cli.py"), plan, cameras, output] + args,
                            capture_output=True)
                        self.assertNotEqual(result.returncode, 0)
                        with open(output, "rb") as f:
                            self.assertEqual(f.read(), b"existing drawing")
            with open(cameras, "w", encoding="utf-8") as f:
                f.write(header + valid)
            result = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "cctv_cli.py"),
                                     plan, cameras, plan], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            with open(plan, "rb") as f:
                self.assertEqual(f.read(), original_plan)

    def test_invalid_geometry_domains_preserve_existing_drawing(self):
        camera = c.Camera("C1", 0, 0, 0, c.Lens(6.4, 1920, 3.2))
        bad_override = c.Camera("C2", 0, 0, 0, c.Lens(6.4, 1920, 3.2),
                                dori_override_m={**c.DORI, "Detect": float("inf")})
        with tempfile.TemporaryDirectory() as d:
            output = os.path.join(d, "result.dxf")
            cases = [([camera], [], {"unit_scale": 0}),
                     ([camera], [], {"unit_scale": float("nan")}),
                     ([camera], [((0, 0), (float("inf"), 1))], {}),
                     ([bad_override], [], {}),
                     ([camera], [], {"dori_level": "Other"})]
            for cameras, walls, kwargs in cases:
                with self.subTest(kwargs=kwargs, walls=walls, cameras=cameras):
                    with open(output, "wb") as f:
                        f.write(b"previous drawing")
                    with self.assertRaises(ValueError):
                        c.build_drawing(cameras, walls, output, **kwargs)
                    with open(output, "rb") as f:
                        self.assertEqual(f.read(), b"previous drawing")
        for args in ((0, 1920, 3.2), (6.4, 0, 3.2), (6.4, 1920, 0),
                     (6.4, 1920, 3.2, 180), (6.4, 1920, 3.2, float("nan"))):
            with self.subTest(lens=args), self.assertRaises(ValueError):
                c.Lens(*args)

    def test_derived_numeric_overflow_preserves_existing_drawing(self):
        lens = c.Lens(6.4, 1920, 3.2)
        camera = c.Camera("C1", 0, 0, 0, lens)
        enormous_dori = {level: 1e308 for level in c.DORI}
        cases = [([camera], 1e-320),
                 ([c.Camera("C1", 0, 0, 0, lens, dori_override_m=enormous_dori)], 0.001),
                 ([c.Camera("C1", 1e308, 0, 0, lens, dori_override_m=enormous_dori)], 1)]
        with tempfile.TemporaryDirectory() as d:
            output = os.path.join(d, "result.dxf")
            for cameras, unit_scale in cases:
                with self.subTest(unit_scale=unit_scale, camera=cameras[0]):
                    with open(output, "wb") as f:
                        f.write(b"previous drawing")
                    with self.assertRaises(ValueError):
                        c.build_drawing(cameras, [], output, unit_scale=unit_scale)
                    with open(output, "rb") as f:
                        self.assertEqual(f.read(), b"previous drawing")
                    self.assertEqual(os.listdir(d), ["result.dxf"])

    def test_storage_rejects_derived_overflow(self):
        self.assertTrue(math.isfinite(c.storage_tb_per_day(1e308)))
        camera = c.Camera("C1", 0, 0, 0, c.Lens(6.4, 1920, 3.2), bitrate_mbps=4)
        with self.assertRaises(ValueError):
            c.storage_total_tb([camera], 1e308, overhead=1e308)

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

    def test_cli_end_to_end_with_utf8_bom(self):
        with tempfile.TemporaryDirectory() as d:
            plan = os.path.join(d, "plan.dxf")
            cameras = os.path.join(d, "cameras.csv")
            output = os.path.join(d, "result.dxf")
            with open(plan, "w", encoding="ascii") as f:
                f.write("0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nA-WALL\n10\n6000\n20\n-5000\n11\n6000\n21\n8000\n0\nENDSEC\n0\nEOF\n")
            with open(cameras, "w", encoding="utf-8-sig", newline="") as f:
                f.write("name,x,y,rotation_deg,model,focal_mm,height_m,tilt_deg,bitrate_mbps\n")
                f.write("ВН-1.1,1000,1000,0,DS-2CD1143G2-I,2.8,3,0,0.72\n")
            completed = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(__file__), "cctv_cli.py"),
                 plan, cameras, output, "--layers", "A-WALL", "--days", "30", "--level", "Observe"],
                check=False, capture_output=True, text=True, encoding="utf-8",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(os.path.isfile(output))
            self.assertIn("Архив 30 сут", completed.stdout)

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
