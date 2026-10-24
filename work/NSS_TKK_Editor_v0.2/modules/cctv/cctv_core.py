#!/usr/bin/env python3
"""cctv_core — расчёт и построение зон видеонаблюдения для AutoCAD (через DXF).

Без внешних зависимостей (только stdlib). Единицы чертежа: миллиметры (по умолчанию),
см. параметр unit_scale (мм -> м = 0.001).

Формулы (общеизвестные, оптика/IEC 62676-4):
  HFOV = 2*atan(sensor_w / (2*f))
  ширина сцены на дистанции d = 2*d*tan(HFOV/2)
  PPM = h_pixels / ширина сцены
  дистанция для порога PPM: d = h_pixels / (PPM * 2*tan(HFOV/2))
  архив ТБ/сут/камера = Мбит/с * 86400 / 8 / 1e6
"""
from __future__ import annotations
import math
import os
import tempfile
import csv
from dataclasses import dataclass, field
from typing import List, Tuple, Dict, Optional

Point = Tuple[float, float]
Segment = Tuple[Point, Point]

# DORI по IEC 62676-4 (пикселей на метр)
DORI = {"Detect": 25.0, "Observe": 62.5, "Recognize": 125.0, "Identify": 250.0}


@dataclass
class Lens:
    sensor_w_mm: float
    h_pixels: int
    focal_mm: float
    hfov_override_deg: float = 0.0  # угол обзора по даташиту (если задан — вместо расчёта по матрице)

    @property
    def hfov_deg(self) -> float:
        if self.hfov_override_deg > 0:
            return self.hfov_override_deg
        return math.degrees(2 * math.atan(self.sensor_w_mm / (2 * self.focal_mm)))


@dataclass
class Camera:
    name: str
    x: float          # единицы чертежа
    y: float
    rotation_deg: float  # направление оси, градусы от оси X против часовой
    lens: Lens
    height_m: float = 3.0
    tilt_deg: float = 0.0  # наклон вниз от горизонта (для 2D-плана — информативно)
    bitrate_mbps: float = 4.0
    model: str = ""
    dori_override_m: Optional[Dict[str, float]] = None


# ---------- оптика / DORI ----------

def scene_width_m(hfov_deg: float, dist_m: float) -> float:
    return 2 * dist_m * math.tan(math.radians(hfov_deg) / 2)


def ppm_at(lens: Lens, dist_m: float) -> float:
    return lens.h_pixels / scene_width_m(lens.hfov_deg, dist_m)


def dori_distances_m(lens: Lens, thresholds: Dict[str, float] = DORI) -> Dict[str, float]:
    k = 2 * math.tan(math.radians(lens.hfov_deg) / 2)
    return {n: lens.h_pixels / (t * k) for n, t in thresholds.items()}


def camera_dori_distances_m(camera: Camera) -> Dict[str, float]:
    """Use supplied manufacturer DORI distances when available, else pixel-density calculation."""
    return camera.dori_override_m or dori_distances_m(camera.lens)


# ---------- геометрия: лучи и стены ----------

def _ray_segment(o: Point, d: Point, a: Point, b: Point) -> Optional[float]:
    """Параметр t>=0 пересечения луча o+t*d с отрезком ab, либо None."""
    ex, ey = b[0] - a[0], b[1] - a[1]
    den = d[0] * ey - d[1] * ex
    ox, oy = a[0] - o[0], a[1] - o[1]
    if abs(den) < 1e-12:
        # Parallel lines can overlap: return the first point on the ray,
        # independently of the order of the segment's endpoints.
        dd = d[0] * d[0] + d[1] * d[1]
        if dd == 0 or abs(ox * d[1] - oy * d[0]) >= 1e-12:
            return None
        ta = (ox * d[0] + oy * d[1]) / dd
        tb = ((b[0] - o[0]) * d[0] + (b[1] - o[1]) * d[1]) / dd
        if max(ta, tb) < 0:
            return None
        return max(0.0, min(ta, tb))
    t = (ox * ey - oy * ex) / den
    u = (ox * d[1] - oy * d[0]) / den
    if t >= 0 and -1e-9 <= u <= 1 + 1e-9:
        return t
    return None


def visibility_polygon(cam_xy: Point, rotation_deg: float, hfov_deg: float,
                       range_units: float, walls: List[Segment],
                       rays: int = 90) -> List[Point]:
    """Сектор обзора с отсечением по стенам. Первая точка — позиция камеры."""
    pts = [cam_xy]
    start = rotation_deg - hfov_deg / 2
    for i in range(rays + 1):
        ang = math.radians(start + hfov_deg * i / rays)
        d = (math.cos(ang), math.sin(ang))
        tmin = range_units
        for a, b in walls:
            t = _ray_segment(cam_xy, d, a, b)
            if t is not None and 1e-6 < t < tmin:
                tmin = t
        pts.append((cam_xy[0] + d[0] * tmin, cam_xy[1] + d[1] * tmin))
    return pts


# ---------- архив ----------

def storage_tb_per_day(bitrate_mbps: float) -> float:
    return bitrate_mbps * 86400 / 8 / 1e6


def storage_total_tb(cams: List[Camera], days: int, overhead: float = 0.0) -> float:
    return sum(storage_tb_per_day(c.bitrate_mbps) for c in cams) * days * (1 + overhead)


# ---------- DXF: чтение (ASCII) ----------

def _pairs(path: str):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    for i in range(0, len(lines) - 1, 2):
        try:
            yield int(lines[i].strip()), lines[i + 1].strip()
        except ValueError:
            continue


def read_walls(path: str, layers: Optional[List[str]] = None) -> List[Segment]:
    """Читает LINE, LWPOLYLINE, POLYLINE из ASCII DXF. layers=None — все слои."""
    want = {l.upper() for l in layers} if layers else None
    segs: List[Segment] = []
    ents: List[List[Tuple[int, str]]] = []
    cur: List[Tuple[int, str]] = []
    in_entities = False
    prev = None
    for code, val in _pairs(path):
        if code == 2 and prev == (0, "SECTION"):
            in_entities = (val == "ENTITIES")
        prev = (code, val)
        if not in_entities:
            continue
        if code == 0:
            if cur:
                ents.append(cur)
            cur = [(code, val)]
            if val == "ENDSEC":
                break
        else:
            cur.append((code, val))
    if cur:
        ents.append(cur)

    poly_open: Optional[dict] = None
    for e in ents:
        kind = e[0][1]
        layer = next((v for c, v in e if c == 8), "0").upper()
        ok = want is None or layer in want
        if kind == "LINE" and ok:
            g = {c: float(v) for c, v in e if c in (10, 20, 11, 21)}
            segs.append(((g[10], g[20]), (g[11], g[21])))
        elif kind == "LWPOLYLINE" and ok:
            flag = int(next((v for c, v in e if c == 70), "0"))
            xs = [float(v) for c, v in e if c == 10]
            ys = [float(v) for c, v in e if c == 20]
            pts = list(zip(xs, ys))
            for a, b in zip(pts, pts[1:]):
                segs.append((a, b))
            if flag & 1 and len(pts) > 2:
                segs.append((pts[-1], pts[0]))
        elif kind == "POLYLINE":
            flag = int(next((v for c, v in e if c == 70), "0"))
            poly_open = {"ok": ok, "closed": bool(flag & 1), "pts": []}
        elif kind == "VERTEX" and poly_open is not None:
            x = next((float(v) for c, v in e if c == 10), None)
            y = next((float(v) for c, v in e if c == 20), None)
            if x is not None and y is not None:
                poly_open["pts"].append((x, y))
        elif kind == "SEQEND" and poly_open is not None:
            if poly_open["ok"]:
                p = poly_open["pts"]
                segs += list(zip(p, p[1:]))
                if poly_open["closed"] and len(p) > 2:
                    segs.append((p[-1], p[0]))
            poly_open = None
    return segs


# ---------- DXF: запись (R12 ASCII, открывается любым AutoCAD) ----------

class DxfWriter:
    def __init__(self):
        self.layers: Dict[str, int] = {"0": 7}
        self.body: List[str] = []
        self.walls_bg: List[Segment] = []

    def layer(self, name: str, color: int):
        self.layers[name] = color

    def _e(self, code, val):
        self.body.append(f"{code}\n{val}")

    def line(self, a: Point, b: Point, layer: str):
        for c, v in ((0, "LINE"), (8, layer), (10, a[0]), (20, a[1]), (30, 0),
                     (11, b[0]), (21, b[1]), (31, 0)):
            self._e(c, v)

    def polyline(self, pts: List[Point], layer: str, closed: bool = True):
        for c, v in ((0, "POLYLINE"), (8, layer), (66, 1), (70, 1 if closed else 0)):
            self._e(c, v)
        for x, y in pts:
            for c, v in ((0, "VERTEX"), (8, layer), (10, x), (20, y), (30, 0)):
                self._e(c, v)
        self._e(0, "SEQEND")
        self._e(8, layer)

    def text(self, p: Point, h: float, s: str, layer: str):
        for c, v in ((0, "TEXT"), (8, layer), (10, p[0]), (20, p[1]), (30, 0),
                     (40, h), (1, s)):
            self._e(c, v)

    def insert_camera(self, cam: Camera, layer: str, scale: float):
        attrs = [("MODEL", cam.model or cam.name), ("HEIGHT_M", f"{cam.height_m}"),
                 ("TILT_DEG", f"{cam.tilt_deg}"), ("ROT_DEG", f"{cam.rotation_deg:.1f}"),
                 ("FOCAL_MM", f"{cam.lens.focal_mm}"), ("HFOV_DEG", f"{cam.lens.hfov_deg:.1f}")]
        for c, v in ((0, "INSERT"), (8, layer), (66, 1), (2, "CCTV_CAM"),
                     (10, cam.x), (20, cam.y), (30, 0), (41, scale), (42, scale),
                     (43, scale), (50, cam.rotation_deg)):
            self._e(c, v)
        for i, (tag, val) in enumerate(attrs):
            for c, v in ((0, "ATTRIB"), (8, layer), (10, cam.x), (20, cam.y), (30, 0),
                         (40, scale * 0.6), (1, val), (2, tag), (70, 1)):
                self._e(c, v)
        self._e(0, "SEQEND")
        self._e(8, layer)

    def save(self, path: str):
        out = ["0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC"]
        t = ["0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n%d" % len(self.layers)]
        for n, col in self.layers.items():
            t.append(f"0\nLAYER\n2\n{n}\n70\n0\n62\n{col}\n6\nCONTINUOUS")
        t.append("0\nENDTAB\n0\nENDSEC")
        out += t
        # блок камеры: треугольник-корпус + ATTDEF
        blk = ["0\nSECTION\n2\nBLOCKS", "0\nBLOCK\n8\n0\n2\nCCTV_CAM\n70\n2\n10\n0\n20\n0\n30\n0",
               "0\nCIRCLE\n8\n0\n10\n0\n20\n0\n30\n0\n40\n0.5",
               "0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n1.2\n21\n0\n31\n0"]
        for i, tag in enumerate(["MODEL", "HEIGHT_M", "TILT_DEG", "ROT_DEG", "FOCAL_MM", "HFOV_DEG"]):
            blk.append(f"0\nATTDEF\n8\n0\n10\n0.7\n20\n{-0.8 - i * 0.7}\n30\n0\n40\n0.5\n"
                       f"1\n-\n3\n{tag}\n2\n{tag}\n70\n1")
        blk.append("0\nENDBLK\n8\n0\n0\nENDSEC")
        out += ["\n".join(blk)]
        out += ["0\nSECTION\n2\nENTITIES\n" + "\n".join(self.body) + "\n0\nENDSEC", "0\nEOF"]
        content = "\n".join(out) + "\n"
        destination = os.path.abspath(path)
        directory = os.path.dirname(destination)
        prefix = "nss-cctv-"
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=directory,
                prefix=prefix, suffix=".tmp", delete=False,
            ) as f:
                temp_path = f.name
                f.write(content)
            os.replace(temp_path, destination)
            temp_path = None
        finally:
            if temp_path is not None:
                try:
                    os.unlink(temp_path)
                except FileNotFoundError:
                    pass


# ---------- каталог и проект ----------

def load_catalog(path: str) -> Dict[str, dict]:
    def _f(k, v):
        if k in ("model", "source"):
            return v
        try:
            return float(v)
        except ValueError:
            return v

    cat = {}
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            cat[r["model"]] = {k: _f(k, v) for k, v in r.items()}
    return cat


def build_drawing(cams: List[Camera], walls: List[Segment], out_path: str,
                  unit_scale: float = 0.001, dori_level: str = "Recognize",
                  background: Optional[List[Segment]] = None) -> Dict[str, List[Point]]:
    """Строит DXF: слои CCTV_CAM, CCTV_FOV, CCTV_DORI_<level>, фон стен. unit_scale: ед.чертежа -> м."""
    w = DxfWriter()
    w.layer("CCTV_CAM", 1)
    w.layer("CCTV_FOV", 3)
    w.layer("CCTV_DORI", 5)
    w.layer("CCTV_TEXT", 7)
    w.layer("WALLS_REF", 8)
    for a, b in (background if background is not None else walls):
        w.line(a, b, "WALLS_REF")
    polys = {}
    for c in cams:
        dist = camera_dori_distances_m(c)
        full = max(dist.values()) if False else dist["Detect"]
        r_fov = full / unit_scale
        poly = visibility_polygon((c.x, c.y), c.rotation_deg, c.lens.hfov_deg, r_fov, walls)
        w.polyline(poly, "CCTV_FOV")
        r_d = dist[dori_level] / unit_scale
        polyd = visibility_polygon((c.x, c.y), c.rotation_deg, c.lens.hfov_deg, r_d, walls)
        w.polyline(polyd, "CCTV_DORI")
        w.insert_camera(c, "CCTV_CAM", 1.0 / unit_scale * 0.15)
        w.text((c.x, c.y + 400), 250, f"{c.name} {dori_level}<={dist[dori_level]:.1f}m", "CCTV_TEXT")
        polys[c.name] = poly
    w.save(out_path)
    return polys


def report_rows(cams: List[Camera], days: int, overhead: float = 0.2):
    rows = []
    for c in cams:
        d = camera_dori_distances_m(c)
        rows.append({"Камера": c.name, "Модель": c.model, "Фокус, мм": c.lens.focal_mm,
                     "HFOV, °": round(c.lens.hfov_deg, 1), "Высота, м": c.height_m,
                     "Detect, м": round(d["Detect"], 1), "Observe, м": round(d["Observe"], 1),
                     "Recognize, м": round(d["Recognize"], 1), "Identify, м": round(d["Identify"], 1),
                     "Битрейт, Мбит/с": c.bitrate_mbps,
                     "ТБ/сут": round(storage_tb_per_day(c.bitrate_mbps), 4),
                     f"ТБ/{days} сут (+{int(overhead*100)}%)":
                         round(storage_tb_per_day(c.bitrate_mbps) * days * (1 + overhead), 3)})
    return rows


def write_xlsx(rows, path: str, total_tb: float, days: int):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Спецификация СВН"
    ws.append(list(rows[0].keys()))
    for r in rows:
        ws.append(list(r.values()))
    ws.append([])
    ws.append([f"Итого архив на {days} сут, ТБ", round(total_tb, 3)])
    wb.save(path)
