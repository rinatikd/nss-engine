"""Помещения из стен: растеризация препятствий + заливка от подписей площади (слой МАРКИ ПОМЕЩЕНИЙ)."""
import sys, re, math, numpy as np
sys.path.insert(0, "/home/claude/cctv")
import cctv_core as cc

SRC = "/home/claude/in2/x/Садик СС 1 этаж.dxf"
OBST = ["СТЕНЫ НАРУЖНЫЕ", "СТЕНЫ ВНУТРЕННИЕ", "СТЕНЫ НЕСУЩИЕ", "СТЕНЫ ПЕРЕГОРОДКИ", "НЕСУЩИЕ КОЛОННЫ",
        "ДВЕРИ", "ОКНА", "ВИТРАЖ", "ПАНЕЛИ ВИТРАЖА"]
CELL = 50.0
X0, Y0, X1, Y1 = 52000, -220000, 112000, -178000

def read_labels(path=SRC):
    f = open(path, encoding="utf-8", errors="replace"); sec = None; pend = False; rec = None; items = []
    def flush(r):
        d = {}
        for c, v in r[1:]: d.setdefault(c, v)
        if r[0][1] == "TEXT" and d.get("8", "").upper() == "МАРКИ ПОМЕЩЕНИЙ":
            items.append((d.get("1", ""), float(d["10"]), float(d["20"])))
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
    areas = []
    for t, x, y in items:
        m = re.fullmatch(r"%%U(\d+),(\d+)", t.strip())
        if m:
            name = " ".join(w for w, wx, wy in items if not w.startswith("%%U") and -1500 < wy - y < 0 and -1000 < wx - x < 2500)
            areas.append((float(m.group(1) + "." + m.group(2)), x, y, name))
    return areas

def raster(walls, thick=1):
    nx, ny = int((X1 - X0) / CELL), int((Y1 - Y0) / CELL)
    g = np.zeros((ny, nx), bool)
    for (a, b) in walls:
        n = max(2, int(math.dist(a, b) / (CELL / 2)))
        xs = np.linspace(a[0], b[0], n); ys = np.linspace(a[1], b[1], n)
        ix = ((xs - X0) / CELL).astype(int); iy = ((ys - Y0) / CELL).astype(int)
        ok = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
        g[iy[ok], ix[ok]] = True
    if thick:
        from scipy.ndimage import binary_dilation
        g = binary_dilation(g, iterations=thick)
    return g

def build(thick=2):
    walls = []
    for L in OBST: walls += cc.read_walls(SRC, [L])
    g = raster(walls, thick)
    from scipy.ndimage import label
    lab, n = label(~g)
    rooms = []
    for area, x, y, name in read_labels():
        best = None
        for dx in (0, 300, 600, 900, -300):
            for dy in (0, 300, -300, 600, -600):
                ix = int((x + dx - X0) / CELL); iy = int((y + dy - Y0) / CELL)
                if not (0 <= ix < lab.shape[1] and 0 <= iy < lab.shape[0]): continue
                l = lab[iy, ix]
                if l == 0: continue
                a = (lab == l).sum() * CELL * CELL / 1e6
                err = abs(a - area) / area
                if best is None or err < best[0]: best = (err, l, a)
        rooms.append({"name": name or "?", "area_label": area, "x": x, "y": y, "lab": None if best is None else int(best[1]), "area_calc": None if best is None else best[2], "err": None if best is None else best[0]})
    return g, lab, rooms
