#!/usr/bin/env python3
"""Пример: python3 cctv_cli.py plan.dxf cameras.csv out.dxf [--layers A-WALL,Стены] [--days 30]
cameras.csv: name,x,y,rotation_deg,model,focal_mm,height_m,tilt_deg,bitrate_mbps
Каталог камер: catalog.csv (параметры из открытых даташитов/ввода пользователя)."""
import argparse, csv, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cctv_core as c

ap = argparse.ArgumentParser()
ap.add_argument("plan"); ap.add_argument("cameras"); ap.add_argument("out")
ap.add_argument("--catalog", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "catalog.csv"))
ap.add_argument("--layers", default=""); ap.add_argument("--days", type=int, default=30)
ap.add_argument("--unit", type=float, default=0.001, help="ед.чертежа->м (мм=0.001)")
ap.add_argument("--level", choices=tuple(c.DORI), default="Recognize"); ap.add_argument("--xlsx", default="")
def main():
    a = ap.parse_args()
    try:
        for destination in [a.out] + ([a.xlsx] if a.xlsx else []):
            for source in [a.plan, a.cameras, a.catalog] + ([a.out] if destination == a.xlsx else []):
                if (os.path.realpath(destination) == os.path.realpath(source) or
                        (os.path.exists(destination) and os.path.exists(source) and os.path.samefile(destination, source))):
                    raise ValueError("Output paths must differ from input paths and from each other")
        cat = c.load_catalog(a.catalog)
        walls = c.read_walls(a.plan, [x for x in a.layers.split(",") if x] or None)
        cams = []
        with open(a.cameras, newline="", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                m = cat[r["model"]]
                fl = float(r["focal_mm"])
                if not m["focal_min"] <= fl <= m["focal_max"]:
                    raise ValueError(f"{r['name']}: фокус вне диапазона модели")
                dori = {name: float(m[f"dori_{name[0].lower()}_m"]) for name in ("Detect", "Observe", "Recognize", "Identify")}
                cams.append(c.Camera(r["name"], float(r["x"]), float(r["y"]), float(r["rotation_deg"]),
                                     c.Lens(m["sensor_w_mm"], int(m["h_pixels"]), fl, float(m["hfov_deg"])), float(r.get("height_m") or 3),
                                     float(r.get("tilt_deg") or 0), float(r.get("bitrate_mbps") or 4), r["model"], dori))
        if not cams:
            raise ValueError("Camera CSV contains no cameras")
        rows = c.report_rows(cams, a.days)
        tot = c.storage_total_tb(cams, a.days, 0.2)
        c.build_drawing(cams, walls, a.out, a.unit, a.level)
        for r in rows: print(r)
        print(f"Архив {a.days} сут (+20%): {tot:.3f} ТБ")
        if a.xlsx: c.write_xlsx(rows, a.xlsx, tot, a.days)
    except (OSError, ValueError, KeyError, TypeError, csv.Error) as exc:
        ap.error(str(exc))


if __name__ == "__main__":
    main()
