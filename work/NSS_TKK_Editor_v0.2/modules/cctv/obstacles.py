"""Препятствия для видимости: стены, колонны, окна, витражи + двери в ЗАКРЫТОМ положении.
Косые линии на слое ДВЕРИ (приоткрытая створка, дуги открывания) — только символы; они выбрасываются,
а вместо каждой створки ставится отрезок закрытой створки поперёк проёма."""
import sys, math
import numpy as np
sys.path.insert(0, "/home/claude/cctv")
import cctv_core as cc
import rooms

SRC = rooms.SRC
MIN_SCORE = 1.8
SOLID = ["СТЕНЫ НАРУЖНЫЕ", "СТЕНЫ ВНУТРЕННИЕ", "СТЕНЫ НЕСУЩИЕ", "СТЕНЫ ПЕРЕГОРОДКИ", "НЕСУЩИЕ КОЛОННЫ",
         "ОКНА", "ВИТРАЖ", "ПАНЕЛИ ВИТРАЖА"]

def _hit(mask, p, r=1):
    ix = int((p[0] - rooms.X0) / rooms.CELL); iy = int((p[1] - rooms.Y0) / rooms.CELL)
    h, w = mask.shape
    if not (r <= ix < w - r and r <= iy < h - r): return False
    return bool(mask[iy - r:iy + r + 1, ix - r:ix + r + 1].any())

def get(return_info=False):
    solid = []
    for L in SOLID:
        for a, b in cc.read_walls(SRC, [L]):
            # исключение: двойная линия толщиной 10 мм между осями 4 и 6 на отметке Y≈-196,5 м — граница эстрады актового зала
            # (нет штриховки и толщины стены), не препятствие. Подтверждено визуально; заказчику сообщено.
            if L == "СТЕНЫ НАРУЖНЫЕ" and abs(a[1] + 196507) < 20 and abs(b[1] + 196507) < 20 and abs(a[0] - b[0]) > 10000:
                continue
            # исключение: края ступеней зрительской трибуны актового зала (низкие, не препятствие для камеры на 3,5 м)
            # боковые грани подиума трибуны (x≈76,76 и 84,03 м, y -197,7…-200,5 м)
            if (-200600 < min(a[1], b[1]) and max(a[1], b[1]) < -197600
                    and (abs(a[0] - 76761) < 15 or abs(a[0] - 84034) < 15) and abs(a[0] - b[0]) < 15) or (
                    abs(a[1] + 197712) < 5 and abs(b[1] + 197712) < 5 and abs(a[0] - b[0]) < 15
                    and (abs(a[0] - 76761) < 15 or abs(a[0] - 84034) < 15)):
                continue
            if (76500 < min(a[0], b[0]) and max(a[0], b[0]) < 84300 and -203600 < a[1] < -198300
                    and abs(a[1] - b[1]) < 20):
                continue
            solid.append((a, b))
    mask = rooms.raster(solid, 0)
    doors = cc.read_walls(SRC, ["ДВЕРИ"])
    keep, leaves = [], []
    for a, b in doors:
        dx, dy = abs(a[0] - b[0]), abs(a[1] - b[1])
        if min(dx, dy) < 2: keep.append((a, b))          # осевые: рамка/закрытая створка
        elif math.dist(a, b) >= 600: leaves.append((a, b))  # косая створка (приоткрытая)
        # мелкие косые — дуги открывания, выбрасываем
    closures, used = [], []
    for a, b in leaves:
        L = math.dist(a, b)
        # шарнир — конец, ближе к стене (к маске)
        best = None
        for hinge, free in ((a, b), (b, a)):
            for ang in (0, 90, 180, 270):
                c = (hinge[0] + L * math.cos(math.radians(ang)), hinge[1] + L * math.sin(math.radians(ang)))
                mid = ((hinge[0] + c[0]) / 2, (hinge[1] + c[1]) / 2)
                if _hit(mask, mid, 1): continue                  # закрытая створка лежит в проёме, а не в стене
                score = (2 if _hit(mask, hinge, 1) else 0) + (2 if _hit(mask, c, 2) else 0)
                # закрытое положение — поворот створки не более чем на ~100° от косого положения
                ang_leaf = math.degrees(math.atan2(free[1] - hinge[1], free[0] - hinge[0]))
                d = abs((ang - ang_leaf + 180) % 360 - 180)
                score -= d / 90 * 0.5
                if best is None or score > best[0]: best = (score, hinge, c)
        if best and best[0] >= MIN_SCORE:
            key = (round(best[1][0] / 200), round(best[1][1] / 200))
            if key in used: continue
            used.append(key); closures.append((best[1], best[2]))
    obst = solid + keep + closures
    if return_info:
        return obst, {"solid": len(solid), "door_axis": len(keep), "leaves": len(leaves), "closures": len(closures)}
    return obst

if __name__ == "__main__":
    o, info = get(True); print(info, len(o))
