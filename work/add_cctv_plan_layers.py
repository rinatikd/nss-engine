from pathlib import Path
from math import atan2, cos, dist, hypot, pi, sin
import copy
import ezdxf
from ezdxf.addons import Importer
from ezdxf import bbox

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "work" / "CCTV_Source_v03.dxf"
TELECOM = ROOT / "ГП_Виллы_12.10.26 для СС_с_телефонной_канализацией.dxf"
OUT = ROOT / "work" / "CCTV_Source_v04.dxf"
TEL_LAYER = "ТЕЛЕФОННАЯ_КАБЕЛЬНАЯ_КАНАЛИЗАЦИЯ"
FENCE_LAYER = "К_Огражд_терр_проект"
TEXT_STYLE = "Standard"
TEXT_HEIGHT = 1.275
LINEWEIGHT = 40  # AutoCAD lineweight in 1/100 mm = 0.40 mm

doc = ezdxf.readfile(PACKAGE)
tel_doc = ezdxf.readfile(TELECOM)
msp = doc.modelspace()

def layer(name, aci, linetype="CONTINUOUS"):
    if name not in doc.layers:
        doc.layers.new(name, dxfattribs={"color": aci, "lineweight": LINEWEIGHT, "linetype": linetype})
    else:
        doc.layers.get(name).dxf.lineweight = LINEWEIGHT
        doc.layers.get(name).dxf.color = aci
        doc.layers.get(name).dxf.linetype = linetype

if "DASHED" not in doc.linetypes:
    doc.linetypes.new("DASHED", dxfattribs={"description": "Dashed __ __ __", "pattern": [0.75, 0.5, -0.25]})
if "DASHDOT" not in doc.linetypes:
    doc.linetypes.new("DASHDOT", dxfattribs={"description": "Dash dot __ . __ .", "pattern": [0.75, 0.5, -0.125, 0, -0.125]})

LAYERS = {
    "СВН_Камеры_периметр": (5, "CONTINUOUS"),
    "СВН_Камеры_проезды": (3, "CONTINUOUS"),
    "СВН_Камеры_купольные": (4, "CONTINUOUS"),
    "СВН_Камеры_PTZ": (6, "CONTINUOUS"),
    "СВН_Тепловизоры": (1, "CONTINUOUS"),
    "СВН_Шкафы_коммутационные": (2, "CONTINUOUS"),
    "СВН_Кабель_ТКК": (4, "DASHED"),
    "СО_ВОЛС_ограждение": (3, "DASHDOT"),
    "СО_Контроллеры_ВОЛС": (6, "CONTINUOUS"),
    "СО_Кабель_связи": (30, "DASHED"),
}
for n, (c, lt) in LAYERS.items():
    layer(n, c, lt)

def xy_bbox(e):
    try:
        b = bbox.extents([e], fast=True)
        if b.has_data:
            return (b.extmin.x, b.extmin.y, b.extmax.x, b.extmax.y)
    except Exception:
        pass
    p = e.dxf.get("insert", None)
    if p is not None:
        return (p.x, p.y, p.x, p.y)
    return None

def inside_view(e):
    b = xy_bbox(e)
    if b is None:
        return False
    return not (b[2] < 5250 or b[0] > 7040 or b[3] < -11300 or b[1] > -10380)

# Bring in the actual telephone duct layer, including its wells, labels and leaders.
tel_entities = [e for e in tel_doc.modelspace() if e.dxf.layer == TEL_LAYER and inside_view(e)]
imp = Importer(tel_doc, doc)
imp.import_entities(tel_entities, msp)
imp.finalize()

# Bring the local building-8 context and its label from the same saved plan.
anchor_box = (6930, -10935, 7025, -10765)
near_building8 = []
for e in tel_doc.modelspace():
    if e.dxf.layer == TEL_LAYER:
        continue
    b = xy_bbox(e)
    if b and not (b[2] < anchor_box[0] or b[0] > anchor_box[2] or b[3] < anchor_box[1] or b[1] > anchor_box[3]):
        near_building8.append(e)
imp.import_entities(near_building8, msp)
imp.finalize()

def vertices(e):
    if e.dxftype() == "LINE":
        return [(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)]
    if e.dxftype() == "LWPOLYLINE":
        return [(float(x), float(y)) for x, y in e.get_points("xy")]
    if e.dxftype() == "POLYLINE":
        return [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
    return []

def length(points):
    return sum(dist(points[i], points[i+1]) for i in range(len(points)-1))

def text(s, x, y, on_layer, h=TEXT_HEIGHT, rotation=0):
    ent = msp.add_text(s, dxfattribs={"insert": (x, y), "height": h, "rotation": rotation,
        "style": TEXT_STYLE, "layer": on_layer, "lineweight": LINEWEIGHT})
    return ent

def line(a, b, on_layer, width=LINEWEIGHT):
    return msp.add_line(a, b, dxfattribs={"layer": on_layer, "lineweight": width})

def add_block(name):
    if name in doc.blocks:
        return doc.blocks.get(name)
    return doc.blocks.new(name=name, base_point=(0, 0))

def block_attribs():
    return {"layer": "0", "color": 0, "lineweight": -2}

def add_ugo(name, kind):
    b = add_block(name)
    a = block_attribs()
    if kind in ("fixed", "thermal"):
        b.add_lwpolyline([(-2,-1.5),(1.5,-1.5),(1.5,1.5),(-2,1.5),(-2,-1.5)], dxfattribs=a)
        b.add_circle((1.5,0), radius=0.45, dxfattribs=a)
        reach = 7.5 if kind == "thermal" else 6.0
        spread = 3.2 if kind == "thermal" else 2.8
        b.add_line((1.5,0),(reach,spread),dxfattribs=a)
        b.add_line((1.5,0),(reach,-spread),dxfattribs=a)
        b.add_line((reach,spread),(reach,-spread),dxfattribs=a)
        if kind == "thermal":
            b.add_line((-1.4,-0.7),(-1.4,0.7),dxfattribs=a)
    elif kind in ("dome", "ptz"):
        b.add_circle((0,0), radius=2.2, dxfattribs=a)
        b.add_line((-1.3,0),(1.3,0),dxfattribs=a)
        b.add_line((0,-1.3),(0,1.3),dxfattribs=a)
        b.add_line((1.8,0),(6.5,3.0),dxfattribs=a)
        b.add_line((1.8,0),(6.5,-3.0),dxfattribs=a)
        b.add_line((6.5,3.0),(6.5,-3.0),dxfattribs=a)
        if kind == "ptz":
            b.add_arc((0,0),radius=2.8,start_angle=25,end_angle=155,dxfattribs=a)
    elif kind == "cabinet":
        b.add_lwpolyline([(-3,-2.5),(3,-2.5),(3,2.5),(-3,2.5),(-3,-2.5)],dxfattribs=a)
        b.add_line((-1.7,1.2),(1.7,1.2),dxfattribs=a)
        b.add_line((-1.7,0),(1.7,0),dxfattribs=a)
        b.add_circle((2.0,-1.5),radius=0.25,dxfattribs=a)
    elif kind == "controller":
        b.add_lwpolyline([(-4,-2.5),(4,-2.5),(4,2.5),(-4,2.5),(-4,-2.5)],dxfattribs=a)
        b.add_circle((-2,0),radius=0.35,dxfattribs=a)
        b.add_circle((0,0),radius=0.35,dxfattribs=a)
        b.add_circle((2,0),radius=0.35,dxfattribs=a)
        b.add_line((-2,-1.5),(2,-1.5),dxfattribs=a)
    return b

UGO = {
    "fixed": ("UGO_SVN_CAMERA", "СВН_Камеры_периметр"),
    "road": ("UGO_SVN_CAMERA", "СВН_Камеры_проезды"),
    "thermal": ("UGO_SVN_THERMAL", "СВН_Тепловизоры"),
    "dome": ("UGO_SVN_DOME", "СВН_Камеры_купольные"),
    "ptz": ("UGO_SVN_PTZ", "СВН_Камеры_PTZ"),
    "cabinet": ("UGO_SVN_CABINET", "СВН_Шкафы_коммутационные"),
    "controller": ("UGO_SO_CONTROLLER", "СО_Контроллеры_ВОЛС"),
}
for k, (bn, _) in UGO.items():
    add_ugo(bn, "fixed" if k in ("fixed","road") else k)

def insert(kind, x, y, angle=0, tag=None, dx=5, dy=4):
    bn, ly = UGO[kind]
    msp.add_blockref(bn, (x,y), dxfattribs={"layer":ly,"rotation":angle,"lineweight":LINEWEIGHT})
    if tag:
        text(tag, x+dx, y+dy, ly)

# Extract a perimeter chain from the surveyed fence geometry, close three short gaps,
# and report its length against the adopted 3,370 m perimeter.
fences = []
for e in msp:
    if e.dxf.layer == FENCE_LAYER and e.dxftype() in ("LWPOLYLINE","POLYLINE"):
        pts = vertices(e)
        l = length(pts)
        if l > 300 and min(x for x,y in pts) > 5300 and max(x for x,y in pts) < 6900:
            fences.append((l, pts))
fence_a = min(fences, key=lambda v: abs(v[0]-1969.7))
fence_b = min(fences, key=lambda v: abs(v[0]-749.1))
fence_c = min(fences, key=lambda v: abs(v[0]-467.6))
F, B, C = fence_a[1], fence_b[1], fence_c[1]
# Start the numbering at the boundary point nearest building 8.
route = [B[-1], F[0], *F[1:], C[0], *C[1:], B[0], *B[1:]]
route = [route[0]] + [p for i,p in enumerate(route[1:],1) if dist(p,route[i-1]) > 0.01]
perimeter_m = length(route)
msp.add_lwpolyline(route, close=True, dxfattribs={"layer":"СО_ВОЛС_ограждение","lineweight":LINEWEIGHT,"linetype":"DASHDOT"})

def point_at(points, s):
    rem = s % length(points)
    for a,b in zip(points,points[1:]):
        seg = dist(a,b)
        if rem <= seg:
            t = 0 if seg == 0 else rem/seg
            return (a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])), atan2(b[1]-a[1],b[0]-a[0])
        rem -= seg
    a,b=points[-2],points[-1]
    return b,atan2(b[1]-a[1],b[0]-a[0])

cx=sum(x for x,y in route[:-1])/max(len(route)-1,1)
cy=sum(y for x,y in route[:-1])/max(len(route)-1,1)
def inward(x,y):
    dx,dy=cx-x,cy-y; n=hypot(dx,dy) or 1
    return dx/n,dy/n

# 67 perimeter cameras, sampled from the building-8 start along the fence chain.
for i in range(67):
    (x,y), tangent = point_at(route, perimeter_m*i/67)
    ix,iy=inward(x,y)
    x,y=x+ix*9,y+iy*9
    aim=atan2(-iy,-ix)*180/pi
    insert("fixed",x,y,aim,f"КП-08-{i+1:02d}",dx=4,dy=4)

# 19 paired thermal stations (38 cameras) on the exterior side of the fence.
for station in range(19):
    (x,y), tangent = point_at(route, perimeter_m*station/19)
    ix,iy=inward(x,y)
    tx,ty=cos(tangent),sin(tangent)
    x,y=x-ix*12,y-iy*12
    for side in (1,-1):
        n=station*2+(1 if side==1 else 2)
        xx,yy=x+side*2*tx,y+side*2*ty
        insert("thermal",xx,yy,(tangent*180/pi if side==1 else tangent*180/pi+180),f"ТВ-08-{n:02d}",dx=4,dy=-5 if side<0 else 4)

# Copy the surveyed telephone-duct route centerlines onto an independent CCTV layer.
cctv_routes=[]
for e in list(msp):
    if e.dxf.layer != TEL_LAYER or e.dxftype() not in ("LWPOLYLINE","POLYLINE"):
        continue
    pts=vertices(e); l=length(pts)
    if l < 80 or not pts:
        continue
    if max(x for x,y in pts)<5350 or min(x for x,y in pts)>6800 or max(y for x,y in pts)<-11250 or min(y for x,y in pts)>-10400:
        continue
    dup=e.copy(); dup.dxf.layer="СВН_Кабель_ТКК"; dup.dxf.lineweight=LINEWEIGHT; dup.dxf.linetype="DASHED"
    msp.add_entity(dup); cctv_routes.append(pts)

def nearest_route_point(x,y):
    best=None
    for pts in cctv_routes:
        for a,b in zip(pts,pts[1:]):
            vx,vy=b[0]-a[0],b[1]-a[1]; den=vx*vx+vy*vy
            if den==0: continue
            t=max(0,min(1,((x-a[0])*vx+(y-a[1])*vy)/den))
            q=(a[0]+t*vx,a[1]+t*vy); d=dist((x,y),q)
            if best is None or d<best[0]: best=(d,q)
    return best

# Put 12 field cabinets around the perimeter, provisionally at the nearest existing
# light-pole/network node. No separate poles are added.
cabinet_pts=[]
for i in range(12):
    (x,y), tangent=point_at(route,perimeter_m*i/12)
    ix,iy=inward(x,y); x,y=x+ix*22,y+iy*22
    cabinet_pts.append((x,y))
    insert("cabinet",x,y,0,f"ШК-08-{i+1:02d}",dx=5,dy=4)
    if cctv_routes:
        found=nearest_route_point(x,y)
        if found and found[0] <= 160:
            line((x,y),found[1],"СВН_Кабель_ТКК")

# 21 road cameras at representative points on the longest internal road axes.
axis_name="П_Оси проездов"
axes=[]
for e in msp:
    if e.dxf.layer==axis_name and e.dxftype() in ("LWPOLYLINE","POLYLINE","LINE"):
        pts=vertices(e); l=length(pts)
        if l>=35 and min(x for x,y in pts)>=5300 and max(x for x,y in pts)<=6850 and min(y for x,y in pts)>=-11250 and max(y for x,y in pts)<=-10400:
            axes.append((l,pts))
axes.sort(key=lambda a:a[0],reverse=True)
selected=[]
for l,pts in axes:
    mid,_=point_at(pts,length(pts)/2)
    if all(dist(mid,p)>35 for p in selected):
        selected.append(mid)
        tang=point_at(pts,length(pts)/2)[1]
        insert("road",mid[0],mid[1],tang*180/pi,f"ВД-08-{len(selected):02d}",dx=4,dy=3)
    if len(selected)==21: break

# Four playground/gazebo nodes from the accepted study; these remain schematic anchors.
amenities=[(5745,-10960),(6010,-10970),(6455,-10915),(6250,-10950)]
for i,(x,y) in enumerate(amenities,1):
    insert("dome",x,y,0,f"КУ-08-{i:02d}",dx=4,dy=4)
    insert("ptz",x+11,y+2,0,f"PTZ-08-{i:02d}",dx=5,dy=-5)

# Building-8 head-end: two fiber-sensor processors and a communications cabinet.
anchor=(6972.79,-10800.18)
text("ЗДАНИЕ 8 / НАЧАЛО НУМЕРАЦИИ",anchor[0]-25,anchor[1]+22,"СО_Контроллеры_ВОЛС",h=TEXT_HEIGHT*1.15)
insert("controller",anchor[0],anchor[1],0,"КС-08-01",dx=7,dy=4)
insert("controller",anchor[0]+12,anchor[1]-8,0,"КС-08-02",dx=7,dy=-4)
insert("cabinet",anchor[0]+23,anchor[1]+1,0,"ШК-08-00",dx=7,dy=4)

# Schematic communications link from building 8 to the nearest existing duct route.
if cctv_routes:
    found=nearest_route_point(*anchor)
    if found:
        line(anchor,found[1],"СО_Кабель_связи")

# Update the plan viewport to show the building-8 numbering origin and the whole site.
plan=doc.layouts.get("СВН-01_План")
for vp in plan.query("VIEWPORT"):
    if vp.dxf.status==2:
        vp.dxf.view_center_point=(6150,-10850)
        vp.dxf.view_height=1450

# Add a compact layer/UGO legend in the free lower-right area of the plan sheet.
def paper_rect(layout,x1,y1,x2,y2):
    layout.add_lwpolyline([(x1,y1),(x2,y1),(x2,y2),(x1,y2),(x1,y1)],dxfattribs={"layer":"СВН_ЛИСТЫ","lineweight":LINEWEIGHT})
def paper_text(layout,s,x,y,h=2.5,aci=7):
    return layout.add_text(s,dxfattribs={"insert":(x,y),"height":h,"style":TEXT_STYLE,"color":aci,"layer":"СВН_ЛИСТЫ","lineweight":LINEWEIGHT})
paper_rect(plan,855,49,1160,130)
paper_text(plan,"СЛОИ И УГО СВН / СО",860,121,3.0,5)
legend=[
 ("СВН_Камеры_периметр — фиксированная камера",5),
 ("СВН_Камеры_проезды — камера общей дороги",3),
 ("СВН_Тепловизоры — наружная тепловизионная камера",1),
 ("СВН_Кабель_ТКК — CCTV-кабель в телефонной канализации",4),
 ("СО_ВОЛС_ограждение — сенсорный кабель по ограждению",3),
 ("СО_Контроллеры_ВОЛС / СВН_Шкафы_коммутационные",6),
]
for i,(s,c) in enumerate(legend): paper_text(plan,s,860,113-i*8,2.45,c)
paper_text(plan,"Все новые линии: 0,40 мм; подписи: Standard / isocpeui.ttf, 1,275.",860,62,2.25,7)
paper_text(plan,f"Сенсорный контур по выбранным полилиниям ≈ {perimeter_m:,.0f} м; принято 3 370 м.",860,54,2.25,1)
paper_text(plan,"УГО расположены концептуально; координаты существующих световых опор уточнить.",860,46,2.25,1)

doc.header["$INSUNITS"] = 4
doc.saveas(OUT)
print(f"saved {OUT}; imported telecom objects={len(tel_entities)}; copied duct routes={len(cctv_routes)}; perimeter={perimeter_m:.1f}m; road cameras={len(selected)}")
