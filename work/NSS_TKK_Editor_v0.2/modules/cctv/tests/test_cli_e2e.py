"""E2E-тесты CLI cctv_cli.py как чёрного ящика. Только стандартная библиотека."""
import hashlib
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[1] / "cctv_cli.py"
CATALOG = CLI.parent / "catalog.csv"

CAM_HEADER = "name,x,y,rotation_deg,model,focal_mm,height_m,tilt_deg,bitrate_mbps"


def write_dxf(path: Path, lines):
    """Пишет минимальный ASCII-DXF с LINE. lines: (layer, x1, y1, x2, y2)."""
    out = ["0", "SECTION", "2", "ENTITIES"]
    for layer, x1, y1, x2, y2 in lines:
        out += [
            "0", "LINE", "8", layer,
            "10", str(x1), "20", str(y1), "30", "0",
            "11", str(x2), "21", str(y2), "31", "0",
        ]
    out += ["0", "ENDSEC", "0", "EOF"]
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def write_cameras(path: Path, rows):
    """Пишет CSV камер с заданным заголовком."""
    lines = [CAM_HEADER]
    for row in rows:
        lines.append(",".join(str(x) for x in row))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_cli(plan, cameras, out, *extra, catalog=None, cwd=None):
    """Запускает CLI изолированно, как требует задание."""
    cmd = [
        sys.executable, "-I", "-X", "utf8",
        str(CLI), str(plan), str(cameras), str(out),
    ]
    if catalog is not None:
        cmd += ["--catalog", str(catalog)]
    cmd += list(extra)
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
    )


def dxf_pairs(path: Path):
    lines = path.read_text(encoding="utf-8").splitlines()
    for i in range(0, len(lines) - 1, 2):
        try:
            yield int(lines[i].strip()), lines[i + 1].strip()
        except ValueError:
            continue


def dxf_records(path: Path):
    cur = None
    for code, val in dxf_pairs(path):
        if code == 0:
            if cur is not None:
                yield cur
            cur = [(code, val)]
        elif cur is not None:
            cur.append((code, val))
    if cur is not None:
        yield cur


def dxf_layer_names(path: Path):
    names = set()
    for rec in dxf_records(path):
        if rec[0][1] == "LAYER":
            for code, val in rec:
                if code == 2:
                    names.add(val)
    return names


def dxf_lines_on_layer(path: Path, layer: str):
    result = []
    for rec in dxf_records(path):
        if rec[0][1] != "LINE":
            continue
        rec_layer = next((v for c, v in rec if c == 8), "")
        if rec_layer != layer:
            continue
        d = {c: v for c, v in rec if c in (10, 20, 11, 21)}
        if all(k in d for k in (10, 20, 11, 21)):
            result.append((
                (float(d[10]), float(d[20])),
                (float(d[11]), float(d[21])),
            ))
    return result


def max_group_10_11(path: Path):
    vals = []
    for code, val in dxf_pairs(path):
        if code in (10, 11):
            try:
                vals.append(float(val))
            except ValueError:
                pass
    return max(vals) if vals else 0.0


def archive_from_stdout(stdout: str):
    m = re.search(r"Архив (\d+) сут \(\+20%\): ([0-9.]+) ТБ", stdout)
    if not m:
        raise AssertionError("не найдена строка архива в stdout: " + stdout)
    return int(m.group(1)), float(m.group(2))


class CliE2E(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_successful_run_creates_layers_and_utf8_stdout(self):
        """Обычный запуск: код 0, слои, строки камер и архив в UTF-8 stdout."""
        plan = self.root / "plan.dxf"
        cameras = self.root / "cameras.csv"
        out = self.root / "result.dxf"
        write_dxf(plan, [
            ("A-WALL", 0, 0, 20000, 0),
            ("A-WALL", 20000, 0, 20000, 12000),
            ("A-WALL", 20000, 12000, 0, 12000),
            ("A-WALL", 0, 12000, 0, 0),
        ])
        write_cameras(cameras, [
            ("VN-1.1", 1000, 1000, 45, "DS-2CD1143G2-I", 2.8, 3, 20, 4),
            ("VN-1.2", 19000, 11000, 225, "DS-2CD2043G2-I", 2.8, 3, 20, 4),
        ])

        p = run_cli(plan, cameras, out, catalog=CATALOG, cwd=self.root)

        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(out.is_file())
        layers = dxf_layer_names(out)
        for name in ("CCTV_CAM", "CCTV_FOV", "CCTV_DORI", "CCTV_TEXT", "WALLS_REF"):
            self.assertIn(name, layers)
        self.assertIn("Камера: VN-1.1", p.stdout)
        self.assertIn("Камера: VN-1.2", p.stdout)
        days, tb = archive_from_stdout(p.stdout)
        self.assertEqual(days, 30)
        self.assertGreater(tb, 0.0)

    def test_days_bounds_and_archive_proportionality(self):
        """--days: 1 и 3650 проходят, 0 и 3651 отклоняются, архив растёт с днями."""
        plan = self.root / "plan.dxf"
        cameras = self.root / "cameras.csv"
        write_dxf(plan, [])
        write_cameras(cameras, [
            ("VN-1", 1000, 1000, 45, "DS-2CD1143G2-I", 2.8, 3, 20, 4),
        ])

        out1 = self.root / "d1.dxf"
        p1 = run_cli(plan, cameras, out1, "--days", "1", catalog=CATALOG, cwd=self.root)
        self.assertEqual(p1.returncode, 0, p1.stderr)
        self.assertEqual(archive_from_stdout(p1.stdout)[0], 1)

        out10 = self.root / "d10.dxf"
        p10 = run_cli(plan, cameras, out10, "--days", "10", catalog=CATALOG, cwd=self.root)
        self.assertEqual(p10.returncode, 0, p10.stderr)
        _, tb1 = archive_from_stdout(p1.stdout)
        _, tb10 = archive_from_stdout(p10.stdout)
        self.assertAlmostEqual(tb10, tb1 * 10, delta=0.01)

        out3650 = self.root / "d3650.dxf"
        p3650 = run_cli(plan, cameras, out3650, "--days", "3650", catalog=CATALOG, cwd=self.root)
        self.assertEqual(p3650.returncode, 0, p3650.stderr)
        self.assertTrue(out3650.is_file())

        for bad in ("0", "3651"):
            with self.subTest(days=bad):
                p = run_cli(plan, cameras, self.root / f"bad_{bad}.dxf",
                            "--days", bad, catalog=CATALOG, cwd=self.root)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn("--days", p.stderr)

    def test_unit_scale_changes_geometry_and_invalid_units_rejected(self):
        """--unit: 0.001 и 1 дают разный масштаб; 0/-1/nan/inf отклоняются."""
        plan = self.root / "plan.dxf"
        cameras = self.root / "cameras.csv"
        write_dxf(plan, [])
        write_cameras(cameras, [
            ("VN-1", 1000, 1000, 45, "DS-2CD1143G2-I", 2.8, 3, 20, 4),
        ])

        out_mm = self.root / "mm.dxf"
        p_mm = run_cli(plan, cameras, out_mm, "--unit", "0.001",
                       catalog=CATALOG, cwd=self.root)
        self.assertEqual(p_mm.returncode, 0, p_mm.stderr)

        out_m = self.root / "m.dxf"
        p_m = run_cli(plan, cameras, out_m, "--unit", "1",
                      catalog=CATALOG, cwd=self.root)
        self.assertEqual(p_m.returncode, 0, p_m.stderr)

        self.assertGreater(max_group_10_11(out_mm), max_group_10_11(out_m) * 5)

        for bad in ("0", "-1", "nan", "inf"):
            with self.subTest(unit=bad):
                p = run_cli(plan, cameras, self.root / f"bad_unit_{bad}.dxf",
                            "--unit", bad, catalog=CATALOG, cwd=self.root)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn("--unit", p.stderr)

    def test_layers_filter_and_case_and_missing_layer(self):
        """--layers: фильтр стен, пусто = все, регистр не важен, неизвестный слой не падает."""
        plan = self.root / "plan.dxf"
        cameras = self.root / "cameras.csv"
        write_dxf(plan, [
            ("A-WALL", 0, 0, 1000, 0),
            ("B-WALL", 0, 5000, 1000, 5000),
        ])
        write_cameras(cameras, [
            ("VN-1", 500, 100, 0, "DS-2CD1143G2-I", 2.8, 3, 0, 4),
        ])

        cases = [
            ("A-WALL", {0.0}),
            ("B-WALL", {5000.0}),
            ("a-wall", {0.0}),
            ("", {0.0, 5000.0}),
            ("NO-SUCH-LAYER", set()),
        ]
        for idx, (layers, expected_y) in enumerate(cases):
            with self.subTest(layers=layers):
                out = self.root / f"layers_{idx}.dxf"
                p = run_cli(plan, cameras, out, "--layers", layers,
                            catalog=CATALOG, cwd=self.root)
                self.assertEqual(p.returncode, 0, p.stderr)
                ys = set()
                for a, b in dxf_lines_on_layer(out, "WALLS_REF"):
                    ys.add(round(a[1], 6))
                    ys.add(round(b[1], 6))
                self.assertEqual(ys, expected_y)

    def test_invalid_level_rejected(self):
        """--level вне DORI отклоняется."""
        plan = self.root / "plan.dxf"
        cameras = self.root / "cameras.csv"
        write_dxf(plan, [])
        write_cameras(cameras, [
            ("VN-1", 1000, 1000, 45, "DS-2CD1143G2-I", 2.8, 3, 20, 4),
        ])
        p = run_cli(plan, cameras, self.root / "out.dxf", "--level", "Unknown",
                    catalog=CATALOG, cwd=self.root)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("--level", p.stderr)

    def test_output_cannot_overwrite_any_source_input(self):
        """Выход не может совпадать с планом, камерами или каталогом; входы не портятся."""
        plan = self.root / "plan.dxf"
        cameras = self.root / "cameras.csv"
        catalog_copy = self.root / "catalog_copy.csv"
        catalog_copy.write_bytes(CATALOG.read_bytes())
        write_dxf(plan, [("A-WALL", 0, 0, 1000, 0)])
        write_cameras(cameras, [
            ("VN-1", 500, 100, 0, "DS-2CD1143G2-I", 2.8, 3, 0, 4),
        ])

        for target in (plan, cameras, catalog_copy):
            with self.subTest(target=target.name):
                before = target.read_bytes()
                p = run_cli(plan, cameras, target, catalog=catalog_copy, cwd=self.root)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn("cannot overwrite", p.stderr)
                self.assertEqual(target.read_bytes(), before)

    def test_empty_camera_csv_rejected(self):
        """CSV только с заголовком отклоняется, выход не создаётся."""
        plan = self.root / "plan.dxf"
        cameras = self.root / "cameras.csv"
        out = self.root / "out.dxf"
        write_dxf(plan, [])
        write_cameras(cameras, [])
        p = run_cli(plan, cameras, out, catalog=CATALOG, cwd=self.root)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("no camera rows", p.stderr)
        self.assertFalse(out.exists())

    def test_focal_outside_model_range_rejected(self):
        """Фокус вне focal_min..focal_max модели отклоняется."""
        plan = self.root / "plan.dxf"
        cameras = self.root / "cameras.csv"
        out = self.root / "out.dxf"
        write_dxf(plan, [])
        write_cameras(cameras, [
            ("VN-1", 1000, 1000, 45, "DS-2CD1143G2-I", 4.0, 3, 20, 4),
        ])
        p = run_cli(plan, cameras, out, catalog=CATALOG, cwd=self.root)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("фокус вне диапазона модели", p.stderr)
        self.assertFalse(out.exists())

    def test_unknown_model_current_behavior_is_keyerror(self):
        """Поведение зафиксировано, не обязательно желаемое: неизвестная модель даёт KeyError."""
        plan = self.root / "plan.dxf"
        cameras = self.root / "cameras.csv"
        out = self.root / "out.dxf"
        write_dxf(plan, [])
        write_cameras(cameras, [
            ("VN-1", 1000, 1000, 45, "NO_SUCH_MODEL", 2.8, 3, 20, 4),
        ])
        p = run_cli(plan, cameras, out, catalog=CATALOG, cwd=self.root)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("NO_SUCH_MODEL", p.stderr)
        self.assertFalse(out.exists())

    def test_cyrillic_spaces_and_braces_in_all_input_paths(self):
        """Кириллица, пробелы и фигурные скобки в путях плана, камер и каталога."""
        plan = self.root / "план{1}.dxf"
        cameras = self.root / "камеры (1).csv"
        catalog = self.root / "каталог {1}.csv"
        out = self.root / "результат {1}.dxf"
        write_dxf(plan, [("A-WALL", 0, 0, 2000, 0)])
        write_cameras(cameras, [
            ("ВН-1", 1000, 1000, 45, "DS-2CD1143G2-I", 2.8, 3, 20, 4),
        ])
        catalog.write_bytes(CATALOG.read_bytes())

        p = run_cli(plan, cameras, out, catalog=catalog, cwd=self.root)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(out.is_file())
        self.assertIn("ВН-1", p.stdout)
        archive_from_stdout(p.stdout)

    def test_validation_failure_preserves_or_does_not_create_output(self):
        """Неудачный запуск не создаёт output и не меняет существующий файл."""
        plan = self.root / "plan.dxf"
        cameras = self.root / "cameras.csv"
        out = self.root / "existing.dxf"
        write_dxf(plan, [])
        write_cameras(cameras, [
            ("VN-1", 1000, 1000, 45, "DS-2CD1143G2-I", 2.8, 3, 20, 4),
        ])
        out.write_bytes(b"PREEXISTING_DXF_SENTINEL")
        before = out.read_bytes()
        before_hash = hashlib.sha256(before).hexdigest()

        p = run_cli(plan, cameras, out, "--days", "0",
                    catalog=CATALOG, cwd=self.root)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(out.read_bytes(), before)
        self.assertEqual(out.stat().st_size, len(before))
        self.assertEqual(hashlib.sha256(out.read_bytes()).hexdigest(), before_hash)

        missing = self.root / "missing.dxf"
        p2 = run_cli(plan, cameras, missing, "--days", "0",
                     catalog=CATALOG, cwd=self.root)
        self.assertNotEqual(p2.returncode, 0)
        self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()