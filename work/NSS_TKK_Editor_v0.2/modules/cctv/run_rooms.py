import sys, math, csv, pickle, numpy as np
sys.path.insert(0, "/home/claude/cctv")
import rooms, cctv_core as cc
from scipy.ndimage import binary_closing, binary_dilation, label
from matplotlib.path import Path
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt

# камеры (полигоны) — из run_sadik2 без графики
src = open("/home/claude/cctv/run_sadik2.py").read().split("import matplotlib")[0]
exec(src)

zone_walls = []
for L in rooms.OBST: zone_walls += cc.read_walls(rooms.SRC, [L])
import obstacles
walls = obstacles.get()
base = rooms.raster(zone_walls, 0)
g = binary_closing(binary_dilation(base, iterations=1), iterations=5)
lab, n = label(~g); sizes = np.bincount(lab.ravel()); big = np.argmax(sizes[1:]) + 1
labels = rooms.read_labels()
zones = {}
for area, x, y, name in labels:
    best = None
    for dx in (0, 300, 600, 900, -300):
        for dy in (0, 300, -300, 600, -600):
            ix = int((x + dx - rooms.X0) / rooms.CELL); iy = int((y + dy - rooms.Y0) / rooms.CELL); l = lab[iy, ix]
            if l and l != big:
                if best is None: best = l
    if best:
        z = zones.setdefault(best, {"area_label": 0, "names": [], "n": 0}); z["area_label"] += area; z["n"] += 1
        if name: z["names"].append(name)
ny, nx = g.shape
xs = rooms.X0 + (np.arange(nx) + .5) * rooms.CELL; ys = rooms.Y0 + (np.arange(ny) + .5) * rooms.CELL
XX, YY = np.meshgrid(xs, ys); pts = np.column_stack([XX.ravel(), YY.ravel()])
def mask_of(poly):
    p = Path(poly); x0, y0 = np.min(poly, 0); x1, y1 = np.max(poly, 0)
    sel = (pts[:, 0] >= x0) & (pts[:, 0] <= x1) & (pts[:, 1] >= y0) & (pts[:, 1] <= y1)
    m = np.zeros(nx * ny, bool); idx = np.where(sel)[0]; m[idx] = p.contains_points(pts[idx]); return m.reshape(ny, nx)
cov_o = np.zeros((ny, nx), bool); cov_r = np.zeros((ny, nx), bool); per_cam = {}
for k, ox, oy, po, pr in draw:
    mo, mr = mask_of(po), mask_of(pr); cov_o |= mo; cov_r |= mr; per_cam[k] = (mo, mr)
cell_m2 = rooms.CELL ** 2 / 1e6
out = []
for l, z in zones.items():
    m = lab == l; a = m.sum() * cell_m2
    z.update(area=a, obs=(m & cov_o).sum() * cell_m2 / a * 100, rec=(m & cov_r).sum() * cell_m2 / a * 100,
             cams=[k for k, (mo, mr) in per_cam.items() if (m & mo).sum() * cell_m2 > 0.5], mask=m)
    out.append(z)
out.sort(key=lambda z: -z["area"])
rows = []
for i, z in enumerate(out, 1):
    err = abs(z["area"] - z["area_label"]) / z["area_label"] * 100
    rows.append([f"З{i}", "; ".join(dict.fromkeys(z["names"]))[:60] or "—", z["n"], round(z["area_label"], 1), round(z["area"], 1), round(err), round(z["obs"]), round(z["rec"]), ", ".join("ВН-" + c for c in z["cams"]) or "нет"])
with open("/home/claude/cctv/demo/sadik_zones.csv", "w", newline="", encoding="utf-8-sig") as fh:
    w = csv.writer(fh, delimiter=";"); w.writerow(["Зона", "Названия", "Подписей", "Площадь по подписям, м²", "Площадь по контуру, м²", "Расхожд. %", "Покрыто Observe %", "Покрыто Recognize %", "Камеры"]); w.writerows(rows)
for r in rows: print(r)
# контуры в DXF + превью
W2 = cc.DxfWriter()
for nme, col in (("WALLS_REF", 8), ("ROOMS", 2), ("CCTV_FOV", 3), ("CCTV_DORI", 5), ("ROOM_TEXT", 7)): W2.layer(nme, col)
for a, b in walls: W2.line(a, b, "WALLS_REF")
fig, ax = plt.subplots(figsize=(18, 11))
for a, b in walls: ax.plot([a[0], b[0]], [a[1], b[1]], color="#555", lw=.3)
for i, z in enumerate(out, 1):
    m = z["mask"].astype(float)
    _f = plt.figure(); cs = _f.add_subplot(111).contour(xs, ys, m, [0.5]); plt.close(_f)
    for seg in cs.allsegs[0]:
        if len(seg) > 3: W2.polyline([tuple(p) for p in seg[::3]], "ROOMS", True)
    ax.contourf(xs, ys, (m.astype(bool) & ~cov_o).astype(float), [0.5, 1.5], colors=["#ff6666"], alpha=.45)
    ax.contourf(xs, ys, (m.astype(bool) & cov_o & ~cov_r).astype(float), [0.5, 1.5], colors=["#66cc66"], alpha=.35)
    ax.contourf(xs, ys, (m.astype(bool) & cov_r).astype(float), [0.5, 1.5], colors=["#4466dd"], alpha=.35)
    cy, cx = np.argwhere(z["mask"]).mean(0); ax.text(xs[int(cx)], ys[int(cy)], f"З{i}\n{z['rec']:.0f}%", fontsize=6, ha="center")
for k, ox, oy, po, pr in draw:
    W2.polyline(po, "CCTV_FOV"); W2.polyline(pr, "CCTV_DORI"); ax.plot(ox, oy, "k.", ms=4); ax.text(ox, oy, k, fontsize=6)
W2.save("/home/claude/cctv/demo/sadik_zones.dxf")
ax.set_aspect("equal"); ax.set_xlim(rooms.X0 + 2000, rooms.X1 - 1000); ax.set_ylim(-217000, -181000)
ax.set_title("Зоны 1 этажа: синий — Recognize, зелёный — только Observe, красный — не покрыто; подпись: % площади в Recognize")
fig.savefig("/home/claude/cctv/demo/sadik_zones.png", dpi=120, bbox_inches="tight")
