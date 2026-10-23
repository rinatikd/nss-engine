import sys, math, csv, collections
sys.path.insert(0, "/home/claude/cctv")
import cctv_core as cc

CAMS_SRC = "/home/claude/in/x/Садик СС.dxf"
WALLS_SRC = "/home/claude/in2/x/Садик СС 1 этаж.dxf"
BBOX = (54000, -217000, 111000, -181000)
WALL_LAYERS = ["СТЕНЫ НАРУЖНЫЕ", "СТЕНЫ ВНУТРЕННИЕ", "СТЕНЫ НЕСУЩИЕ", "СТЕНЫ ПЕРЕГОРОДКИ", "НЕСУЩИЕ КОЛОННЫ"]
MODEL = {"купольная цветная вк": ("DS-2CD2143", 4.8, 2560), "камера уличная": ("DS-2CD2043", 4.8, 2688)}

def inserts(path):
    f = open(path, encoding="utf-8", errors="replace"); sec = None; pend = False; rec = None
    while True:
        c = f.readline()
        if not c: break
        v = f.readline().rstrip("\r\n"); c = c.strip()
        if c == "0":
            if rec and sec == "ENTITIES" and rec[0][1] == "INSERT":
                d = {}
                for k, x in rec[1:]: d.setdefault(k, x)
                if d.get("8") == "КАМЕРА": yield d
            rec = None
            if v == "SECTION": pend = True
            elif v == "ENDSEC": sec = None
            elif sec == "ENTITIES": rec = [(c, v)]
            continue
        if pend and c == "2": sec = v; pend = False; continue
        if rec is not None: rec.append((c, v))

cams = []
for d in inserts(CAMS_SRC):
    x, y = float(d["10"]), float(d["20"])
    if not (BBOX[0] <= x <= BBOX[2] and BBOX[1] <= y <= BBOX[3]): continue
    name = d["2"]
    if name not in MODEL: continue
    rot = float(d.get("50", 0)); sx = float(d.get("41", 1))
    direction = rot + (180 if sx < 0 else 0)
    m, sw, hp = MODEL[name]
    cams.append((name, m, x, y, direction % 360, sw, hp))
print("камер в зоне 1 этажа:", len(cams), collections.Counter(c[0] for c in cams))

walls = []
for L in WALL_LAYERS: walls += cc.read_walls(WALLS_SRC, [L])
print("сегментов стен:", len(walls))

# ускорение: сегменты по bbox вокруг камеры
def near(walls, x, y, r):
    return [w for w in walls if min(w[0][0], w[1][0]) - r < x < max(w[0][0], w[1][0]) + r and min(w[0][1], w[1][1]) - r < y < max(w[0][1], w[1][1]) + r]

W = cc.DxfWriter()
for n, col in (("WALLS_REF", 8), ("CCTV_CAM", 1), ("CCTV_FOV", 3), ("CCTV_DORI", 5), ("CCTV_TEXT", 7)): W.layer(n, col)
for a, b in walls: W.line(a, b, "WALLS_REF")
rows = []; polys = []
for i, (name, m, x, y, rot, sw, hp) in enumerate(sorted(cams, key=lambda c: (c[3], c[2])), 1):
    lens = cc.Lens(sw, hp, 2.8)
    d = cc.dori_distances_m(lens)
    r_f = min(d["Observe"], 30) * 1000       # длина сектора FOV ограничена Observe/30 м для читаемости
    r_d = d["Recognize"] * 1000
    nw = near(walls, x, y, r_f)
    pf = cc.visibility_polygon((x, y), rot, lens.hfov_deg, r_f, nw)
    pd = cc.visibility_polygon((x, y), rot, lens.hfov_deg, r_d, nw)
    W.polyline(pf, "CCTV_FOV"); W.polyline(pd, "CCTV_DORI")
    W.text((x, y + 300), 250, f"K{i}", "CCTV_TEXT")
    polys.append((i, x, y, rot, pf, pd))
    rows.append([f"K{i}", name, m, round(x), round(y), round(rot, 1), round(lens.hfov_deg, 1),
                 round(d["Detect"], 1), round(d["Observe"], 1), round(d["Recognize"], 1), round(d["Identify"], 1)])
W.save("/home/claude/cctv/demo/sadik_1floor_result.dxf")
with open("/home/claude/cctv/demo/sadik_cameras.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f, delimiter=";"); w.writerow(["N", "Блок", "Модель", "X", "Y", "Напр.°", "HFOV°(по матрице)", "Detect м", "Observe м", "Recognize м", "Identify м"]); w.writerows(rows)

import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(16, 9))
for a, b in walls: ax.plot([a[0], b[0]], [a[1], b[1]], color="#555", lw=.4)
for i, x, y, rot, pf, pd in polys:
    ax.fill([p[0] for p in pf], [p[1] for p in pf], color="green", alpha=.12, lw=0)
    ax.fill([p[0] for p in pd], [p[1] for p in pd], color="blue", alpha=.25, lw=0)
    ax.plot(x, y, "r.", ms=4); ax.text(x, y, f"K{i}", fontsize=5, color="red")
ax.set_aspect("equal"); ax.set_xlim(BBOX[0], BBOX[2]); ax.set_ylim(BBOX[1], BBOX[3])
ax.set_title("1 этаж: зелёный — до Observe (≤30 м), синий — Recognize 125 px/m; HFOV по матрице 1/3\" (не даташит)")
fig.savefig("/home/claude/cctv/demo/sadik_preview.png", dpi=130, bbox_inches="tight")
print(rows[:3])
