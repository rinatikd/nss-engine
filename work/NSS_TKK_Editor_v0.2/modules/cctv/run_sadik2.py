import sys, math, csv, re, collections
sys.path.insert(0, "/home/claude/cctv")
import cctv_core as cc
import axes, json
GYM = json.load(open('/home/claude/cctv/demo/gym_cam.json'))
from camdxf import inserts

SRC_CAMS = "/home/claude/in/x/Садик СС.dxf"
SRC_WALLS = "/home/claude/in2/x/Садик СС 1 этаж.dxf"
BBOX = (54000, -217000, 111000, -181000)
OBST = ["СТЕНЫ НАРУЖНЫЕ", "СТЕНЫ ВНУТРЕННИЕ", "СТЕНЫ НЕСУЩИЕ", "СТЕНЫ ПЕРЕГОРОДКИ", "НЕСУЩИЕ КОЛОННЫ",
        "ДВЕРИ", "ОКНА", "ВИТРАЖ", "ПАНЕЛИ ВИТРАЖА"]
STREET = {"1.9", "1.10", "1.19", "1.20", "1.21", "1.22", "1.23", "1.24", "2.1"}   # DS-2CD2043G2-I по ведомости и указанию заказчика
cat = cc.load_catalog("/home/claude/cctv/catalog.csv")

# --- разбор камерного DXF: подписи и уголки на слое КАМЕРА
labels, tris = {}, []
f = open(SRC_CAMS, encoding="utf-8", errors="replace"); sec = None; pend = False; rec = None
def flush(r):
    t = r[0][1]; d = {}
    for c, v in r[1:]: d.setdefault(c, v)
    if t == "TEXT":
        m = re.fullmatch(r"ВН-(\d\.\d+)", d.get("1", "").strip())
        if m:
            x, y = float(d["10"]), float(d["20"])
            if BBOX[0] < x < BBOX[2] and BBOX[1] < y < BBOX[3]: labels[m.group(1)] = (x, y)
    if t == "LWPOLYLINE" and d.get("8") == "КАМЕРА":
        xs = [float(v) for c, v in r if c == "10"]; ys = [float(v) for c, v in r if c == "20"]
        if len(xs) == 3 and BBOX[0] < xs[0] < BBOX[2] and BBOX[1] < ys[0] < BBOX[3]: tris.append(list(zip(xs, ys)))
while True:
    c = f.readline()
    if not c: break
    v = f.readline().rstrip("\r\n"); c = c.strip()
    if c == "0":
        if rec and sec == "ENTITIES": flush(rec)
        rec = None
        if v == "SECTION": pend = True
        elif v == "ENDSEC": sec = None
        elif sec == "ENTITIES": rec = [(c, v)]
        continue
    if pend and c == "2": sec = v; pend = False; continue
    if rec is not None: rec.append((c, v))
print("подписей ВН:", len(labels), " уголков:", len(tris))

def corner(tri):
    # вершина прямого угла = противоположная самой длинной стороне
    i = max(range(3), key=lambda k: math.dist(tri[(k + 1) % 3], tri[(k + 2) % 3]))
    p = tri[i]; a = tri[(i + 1) % 3]; b = tri[(i + 2) % 3]
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    ang = math.degrees(math.atan2(mid[1] - p[1], mid[0] - p[0])) % 360
    return p, ang, math.dist(p, mid)

# сопоставление подпись -> уголок с учётом вида камеры (на чертеже: купол = окружность, уличная = повёрнутый прямоугольник;
# уголок купола — равнобедренный (катеты ≈1989/1966), уголок уличной — неравные катеты ≈2031/2312)
BULLET = {"1.9", "1.10", "1.19", "1.20", "1.21", "1.22", "1.23", "1.24", "2.1"}
def tri_kind(t):
    sides = sorted(math.dist(t[i], t[(i + 1) % 3]) for i in range(3))
    return "bullet" if abs(sides[0] - sides[1]) > 100 else "dome"
pairs = sorted(((math.dist(lp, corner(t)[0]), k, i) for k, lp in labels.items() for i, t in enumerate(tris)
                if tri_kind(t) == ("bullet" if k in BULLET else "dome")))
used_l, used_t, assign = set(), set(), {}
for dist, k, i in pairs:
    if k in used_l or i in used_t: continue
    used_l.add(k); used_t.add(i); assign[k] = (i, dist)
print("сопоставлено:", len(assign), "без уголка:", sorted(set(labels) - set(assign)), "лишние уголки:", len(tris) - len(used_t))

INS = []
for d in inserts(SRC_CAMS):
    x, y = float(d["10"]), float(d["20"])
    if BBOX[0] <= x <= BBOX[2] and BBOX[1] <= y <= BBOX[3]:
        INS.append((x, y, (float(d.get("50", 0)) + (180 if float(d.get("41", 1)) < 0 else 0)) % 360))
import obstacles
walls = obstacles.get()
print("препятствий:", len(walls))
def near(x, y, r):
    return [w for w in walls if min(w[0][0], w[1][0]) - r < x < max(w[0][0], w[1][0]) + r and min(w[0][1], w[1][1]) - r < y < max(w[0][1], w[1][1]) + r]

def area(p):
    return abs(sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))) / 2 / 1e6

W = cc.DxfWriter()
for n, col in (("WALLS_REF", 8), ("CCTV_CAM", 1), ("CCTV_FOV", 3), ("CCTV_DORI", 5), ("CCTV_TEXT", 7)): W.layer(n, col)
for a, b in walls: W.line(a, b, "WALLS_REF")
rows, draw = [], []
key = lambda k: tuple(int(x) for x in k.split("."))
for k in sorted(assign, key=key):
    t = tris[assign[k][0]]; p, ang, _ = corner(t); dir_src = "уголок (блока нет)"
    if INS:
        nb = min(INS, key=lambda i: math.dist((i[0], i[1]), p))
        if math.dist((nb[0], nb[1]), p) < 400: ang = nb[2]; dir_src = "блок камеры"
    model = "DS-2CD2043G2-I" if k in STREET else "DS-2CD1143G2-I"
    m = cat[model]
    lens = cc.Lens(m["sensor_w_mm"], int(m["h_pixels"]), 2.8, hfov_override_deg=m["hfov_deg"])
    d = {"Detect": m["dori_d_m"], "Observe": m["dori_o_m"], "Recognize": m["dori_r_m"], "Identify": m["dori_i_m"]}  # по даташиту
    ox = p[0] + 200 * math.cos(math.radians(ang)); oy = p[1] + 200 * math.sin(math.radians(ang))   # шаг от стены
    if k == "1.11":   # планировка изменилась: камера перенесена в спортзал (предложение проектировщика-ассистента)
        ox, oy, ang, dir_src = GYM["x"], GYM["y"], GYM["dir"], "предложено: спортзал"
    r_o, r_r = d["Observe"] * 1000, d["Recognize"] * 1000
    nw = near(ox, oy, r_o)
    po = cc.visibility_polygon((ox, oy), ang, lens.hfov_deg, r_o, nw, rays=120)
    pr = cc.visibility_polygon((ox, oy), ang, lens.hfov_deg, r_r, nw, rays=120)
    W.polyline(po, "CCTV_FOV"); W.polyline(pr, "CCTV_DORI")
    W.text((ox, oy + 300), 250, f"ВН-{k}", "CCTV_TEXT")
    free = max(math.dist((ox, oy), q) for q in pr[1:])  # до какого расстояния реально видно (макс.)
    rows.append([f"ВН-{k}", model, axes.ref(ox, oy), axes.compass(ang), round(ang), lens.hfov_deg,
                 round(d["Observe"], 1), round(d["Recognize"], 1), round(area(po), 1), round(area(pr), 1), round(assign[k][1] / 1000, 2), dir_src])
    draw.append((k, ox, oy, po, pr))
W.save("/home/claude/cctv/demo/sadik_1floor_result_v2.dxf")
hdr = ["Камера", "Модель", "Привязка к осям", "Куда смотрит (по плану)", "Угол, °", "HFOV° (по даташиту)", "Observe м", "Recognize м", "Площадь Observe м²", "Площадь Recognize м²", "Откл. подписи от камеры, м", "Источник направления"]
with open("/home/claude/cctv/demo/sadik_cameras_v2.csv", "w", newline="", encoding="utf-8-sig") as fh:
    w = csv.writer(fh, delimiter=";"); w.writerow(hdr); w.writerows(rows)
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(18, 11))
for a, b in walls: ax.plot([a[0], b[0]], [a[1], b[1]], color="#444", lw=.35)
for k, x, y, po, pr in draw:
    ax.fill([q[0] for q in po], [q[1] for q in po], color="green", alpha=.13, lw=0)
    ax.fill([q[0] for q in pr], [q[1] for q in pr], color="blue", alpha=.28, lw=0)
    ax.plot(x, y, "r.", ms=5); ax.text(x, y, k, fontsize=7, color="red", weight="bold")
ax.set_aspect("equal"); ax.set_xlim(BBOX[0], BBOX[2]); ax.set_ylim(BBOX[1], BBOX[3])
ax.set_title("1 этаж: зелёный — Observe 62,5 px/м, синий — Recognize 125 px/м; углы обзора по даташиту; двери/окна — преграды")
fig.savefig("/home/claude/cctv/demo/sadik_preview_v2.png", dpi=120, bbox_inches="tight")
for r in rows: print(r)
