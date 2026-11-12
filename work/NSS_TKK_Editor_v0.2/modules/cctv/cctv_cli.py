#!/usr/bin/env python3
"""Пример: python3 cctv_cli.py plan.dxf cameras.csv out.dxf [--layers A-WALL,Стены] [--days 30]
cameras.csv: name,x,y,rotation_deg,model,focal_mm,height_m,tilt_deg,bitrate_mbps
Каталог камер: catalog.csv (параметры из открытых даташитов/ввода пользователя)."""
import argparse, csv, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cctv_core as c

ap = argparse.ArgumentParser()
ap.add_argument("plan"); ap.add_argument("cameras"); ap.add_argument("out")
ap.add_argument("--catalog", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog.csv"))
ap.add_argument("--layers", default=""); ap.add_argument("--days", type=int, default=30)
ap.add_argument("--unit", type=float, default=0.001, help="ед.чертежа->м (мм=0.001)")
ap.add_argument("--level", default="Recognize"); ap.add_argument("--xlsx", default="")
a = ap.parse_args()
if not (math.isfinite(a.unit) and a.unit > 0):
    ap.error("--unit must be a positive finite number")
if not 1 <= a.days <= 3650:
    ap.error("--days must be between 1 and 3650")
if a.level not in c.DORI:
    ap.error("--level must be one of " + ", ".join(c.DORI))
if os.path.normcase(os.path.realpath(a.out)) in {
    os.path.normcase(os.path.realpath(a.plan)),
    os.path.normcase(os.path.realpath(a.cameras)),
    os.path.normcase(os.path.realpath(a.catalog)),
}:
    ap.error("output DXF cannot overwrite a source input")
cat = c.load_catalog(a.catalog)
walls = c.read_walls(a.plan, [x for x in a.layers.split(",") if x] or None)
cams = []
with open(a.cameras, newline="", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        m = cat[r["model"]]
        fl = float(r["focal_mm"])
        if not (math.isfinite(fl) and m["focal_min"] <= fl <= m["focal_max"]):
            raise ValueError(f"{r['name']}: фокус вне диапазона модели")
        dori = {name: float(m[f"dori_{name[0].lower()}_m"]) for name in ("Detect", "Observe", "Recognize", "Identify")}
        cams.append(c.Camera(r["name"], float(r["x"]), float(r["y"]), float(r["rotation_deg"]),
                             c.Lens(m["sensor_w_mm"], int(m["h_pixels"]), fl, float(m["hfov_deg"])), float(r.get("height_m") or 3),
                             float(r.get("tilt_deg") or 0), float(r.get("bitrate_mbps") or 4), r["model"], dori))
if not cams:
    ap.error("camera CSV contains no camera rows")
# Validate report calculations before any output DXF is published.
rows = c.report_rows(cams, a.days)
tot = c.storage_total_tb(cams, a.days, 0.2)
c.build_drawing(cams, walls, a.out, a.unit, a.level)
for r in rows: print("; ".join(f"{k}: {v}" for k, v in r.items()))
print(f"Архив {a.days} сут (+20%): {tot:.3f} ТБ")
if a.xlsx: c.write_xlsx(rows, a.xlsx, tot, a.days)
