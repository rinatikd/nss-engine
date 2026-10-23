import sys, math, json, numpy as np
sys.path.insert(0, "/home/claude/cctv")
import rooms, obstacles, axes, cctv_core as cc
from scipy.ndimage import binary_closing, binary_dilation, label, distance_transform_edt
from matplotlib.path import Path
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt

zone_walls = []
for L in rooms.OBST: zone_walls += cc.read_walls(rooms.SRC, [L])
base = rooms.raster(zone_walls, 0)
g = binary_closing(binary_dilation(base, iterations=1), iterations=5)
lab, n = label(~g)
labels = rooms.read_labels()
gym = [l for l in labels if abs(l[0] - 81.2) < 0.5][0]
area, x, y, name = gym
l = 0
for dx in (0, 300, 600, 900, -300, 1500):
    for dy in (0, 300, -300, 600, -600, 1500):
        ix = int((x + dx - rooms.X0) / rooms.CELL); iy = int((y + dy - rooms.Y0) / rooms.CELL)
        if lab[iy, ix] and (lab == lab[iy, ix]).sum() * rooms.CELL ** 2 / 1e6 < 140: l = lab[iy, ix]
mask = lab == l
print("актовый зал: площадь по контуру, м²:", round(mask.sum() * rooms.CELL ** 2 / 1e6, 1))
ny, nx = mask.shape
ys_i, xs_i = np.where(mask)
x_min, x_max = rooms.X0 + xs_i.min() * rooms.CELL, rooms.X0 + (xs_i.max() + 1) * rooms.CELL
y_min, y_max = rooms.Y0 + ys_i.min() * rooms.CELL, rooms.Y0 + (ys_i.max() + 1) * rooms.CELL
print("габариты зала, м:", round((x_max - x_min) / 1000, 1), "×", round((y_max - y_min) / 1000, 1))
cx, cy = rooms.X0 + (xs_i.mean() + .5) * rooms.CELL, rooms.Y0 + (ys_i.mean() + .5) * rooms.CELL

walls = obstacles.get()
near = [w for w in walls if x_min - 1500 < max(w[0][0], w[1][0]) and min(w[0][0], w[1][0]) < x_max + 1500 and y_min - 1500 < max(w[0][1], w[1][1]) and min(w[0][1], w[1][1]) < y_max + 1500]
dt = distance_transform_edt(mask) * rooms.CELL
HFOV, R, O = 99.0, 11000, 23000     # DS-2CD1143G2-I по даташиту
X = rooms.X0 + (np.arange(nx) + .5) * rooms.CELL; Y = rooms.Y0 + (np.arange(ny) + .5) * rooms.CELL
XX, YY = np.meshgrid(X, Y); pts = np.column_stack([XX.ravel(), YY.ravel()])
sub = np.zeros(nx * ny, bool); sub[(pts[:, 0] >= x_min) & (pts[:, 0] <= x_max) & (pts[:, 1] >= y_min) & (pts[:, 1] <= y_max)] = True
def cover(poly):
    p = Path(poly); m = np.zeros(nx * ny, bool); idx = np.where(sub)[0]; m[idx] = p.contains_points(pts[idx]); return m.reshape(ny, nx) & mask
tot = mask.sum()
# кандидаты: точки вдоль периметра в 250–350 мм от стены, шаг ≈1 м
cand = []
ring = np.argwhere(mask & (dt > 220) & (dt < 330))
last = []
for iy, ix in ring[::1]:
    px, py = rooms.X0 + (ix + .5) * rooms.CELL, rooms.Y0 + (iy + .5) * rooms.CELL
    if all(math.dist((px, py), q) > 900 for q in last): last.append((px, py))
print("кандидатов точек:", len(last))
res = []
for (px, py) in last:
    a0 = math.degrees(math.atan2(cy - py, cx - px))
    for da in (-45, -22, 0, 22, 45):
        ang = a0 + da
        pr = cc.visibility_polygon((px, py), ang, HFOV, R, near, rays=90)
        po = cc.visibility_polygon((px, py), ang, HFOV, O, near, rays=90)
        mr, mo = cover(pr), cover(po)
        res.append((mr.sum() / tot, mo.sum() / tot, px, py, ang, mr, mo))
res.sort(key=lambda r: -(r[0] + .3 * r[1]))
best = res[0]
print("лучшая одиночная: Recognize %.0f%%, Observe %.0f%%" % (best[0] * 100, best[1] * 100))
# пара камер: лучшая из топ-60 вторая, максимизирующая объединение
top = res[:60]; bp = None
for i, a in enumerate(top):
    for b in top[i + 1:]:
        u = (a[5] | b[5]).sum() / tot
        if bp is None or u > bp[0]: bp = (u, a, b)
print("лучшая пара: Recognize %.0f%%" % (bp[0] * 100))
for tag, r in (("одиночная", best),):
    print(tag, axes.ref(r[2], r[3]), "напр.", round(r[4] % 360), axes.compass(r[4]))
H_MOUNT = 3.5
dfar = max(math.dist((best[2], best[3]), (rooms.X0 + (c + .5) * rooms.CELL, rooms.Y0 + (r + .5) * rooms.CELL)) for r, c in zip(*np.where(best[5] | best[6]))) / 1000
dtgt = min(dfar, 11.0) * 0.6
tilt = math.degrees(math.atan((H_MOUNT - 1.5) / dtgt))
blind = (H_MOUNT - 1.5) / math.tan(math.radians(tilt + 27.5))
print("Высота %.1f м; наклон %.0f°; слепая зона у стены на уровне 1,5 м: %.1f м" % (H_MOUNT, tilt, blind))
json.dump({"x": best[2], "y": best[3], "dir": best[4] % 360, "rec": best[0], "obs": best[1], "pair_rec": bp[0], "height": H_MOUNT, "tilt": tilt, "blind": blind,
           "ref": axes.ref(best[2], best[3]), "dims": [(x_max - x_min) / 1000, (y_max - y_min) / 1000],
           "pair": [{"x": a[2], "y": a[3], "dir": a[4] % 360, "ref": axes.ref(a[2], a[3])} for a in (bp[1], bp[2])]}, open("/home/claude/cctv/demo/hall_cam.json", "w"), ensure_ascii=False)
fig, ax = plt.subplots(figsize=(9, 9))
for a, b in near: ax.plot([a[0], b[0]], [a[1], b[1]], color="#555", lw=.6)
Xc = rooms.X0 + (np.arange(nx) + .5) * rooms.CELL; Yc = rooms.Y0 + (np.arange(ny) + .5) * rooms.CELL
ax.contourf(Xc, Yc, mask.astype(float), [0.5, 1.5], colors=["#dddddd"], alpha=.6)
ax.contourf(Xc, Yc, best[6].astype(float), [0.5, 1.5], colors=["#66cc66"], alpha=.5)
ax.contourf(Xc, Yc, best[5].astype(float), [0.5, 1.5], colors=["#3366dd"], alpha=.5)
u = (bp[1][5] | bp[2][5])
ax.contour(Xc, Yc, u.astype(float), [0.5], colors=["#cc00cc"], linewidths=1.2, linestyles="--")
for t in (bp[1], bp[2]): ax.plot(t[2], t[3], "m^", ms=7)
ax.plot(best[2], best[3], "r^", ms=9)
ax.set_xlim(x_min - 1200, x_max + 1200); ax.set_ylim(y_min - 1200, y_max + 1200); ax.set_aspect("equal")
ax.set_title("Актовый зал: красный ▲ — одна камера (синий — Recognize 11 м, зелёный — Observe 23 м); фиолетовый пунктир — вариант с двумя камерами")
fig.savefig("/home/claude/cctv/demo/hall_proposal.png", dpi=110, bbox_inches="tight")
