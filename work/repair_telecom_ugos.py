"""Restore missing telephone-sewer manhole UGOs and apply the requested 0.40 mm layer weight."""
import json, math, re, shutil
from pathlib import Path
import ezdxf

ROOT=Path(__file__).resolve().parents[1]
DXF=ROOT/'ГП_Виллы_12.10.26 для СС_с_телефонной_канализацией.dxf'
OUT=ROOT/'ГП_Виллы_12.10.26 для СС_с_телефонной_канализацией_исправлены_УГО_04мм.dxf'
BACKUP=ROOT/'ГП_Виллы_12.10.26 для СС_с_телефонной_канализацией.pre_missing_ugos.bak'
LAYER='\u0422\u0415\u041b\u0415\u0424\u041e\u041d\u041d\u0410\u042f_\u041a\u0410\u0411\u0415\u041b\u042c\u041d\u0410\u042f_\u041a\u0410\u041d\u0410\u041b\u0418\u0417\u0410\u0426\u0418\u042f'
TARGET_LW=40

doc=ezdxf.readfile(DXF)
msp=doc.modelspace()
def xy(p): return (float(p[0]),float(p[1]))
def d(a,b): return math.hypot(a[0]-b[0],a[1]-b[1])

# Existing leader arrow points are the authoritative well centers.
nodes={}
for e in msp.query('MULTILEADER'):
    if e.dxf.layer!=LAYER: continue
    try:
        content=e.context.mtext.default_content
        pts=e.context.leaders[0].lines[0].vertices
        match=re.search(r'КК\s*-?\s*(\d+)',content,re.I)
        if match and pts: nodes[int(match.group(1))]=xy(pts[-1])
    except Exception: pass

# Measure existing block symbols in world coordinates, including their transformed geometry.
symbols=[]
for e in msp.query('INSERT'):
    if e.dxf.layer!=LAYER: continue
    try:
        for v in e.virtual_entities():
            if v.dxftype()=='CIRCLE': symbols.append(xy(v.dxf.center))
    except Exception: pass

missing=[]
for n,p in sorted(nodes.items()):
    if min((d(p,q) for q in symbols),default=1e9)>0.05:
        missing.append((n,p))

if not missing:
    raise SystemExit('No missing UGOs found; no changes made.')
if not BACKUP.exists(): shutil.copy2(DXF,BACKUP)

# Use a real existing UGO as the geometric template; make all components obey the layer style.
template_insert=None; template_circle=None; template_poly=None; best=1e9
for ins in msp.query('INSERT'):
    if ins.dxf.layer!=LAYER: continue
    try: virtual=list(ins.virtual_entities())
    except Exception: continue
    circle=next((v for v in virtual if v.dxftype()=='CIRCLE'),None)
    poly=next((v for v in virtual if v.dxftype()=='LWPOLYLINE'),None)
    if circle is None or poly is None: continue
    # Favor the canonical, small circular well symbol.
    score=abs(circle.dxf.radius-0.3153745406428498)
    if score<best: best=score; template_insert=ins; template_circle=circle; template_poly=poly
if template_circle is None: raise SystemExit('Could not find a circular UGO template.')
center=xy(template_circle.dxf.center)
offsets=[(float(p[0])-center[0],float(p[1])-center[1]) for p in template_poly.get_points('xy')]
radius=float(template_circle.dxf.radius)
linetype=template_circle.dxf.linetype
color=int(template_circle.dxf.color)
ltscale=float(template_circle.dxf.ltscale)

# Move the circular block's internal graphics onto the project layer and honor 0.40 mm.
block=doc.blocks.get(template_insert.dxf.name)
for e in block:
    if e.dxftype() in ('CIRCLE','LWPOLYLINE'):
        e.dxf.layer=LAYER
        e.dxf.lineweight=TARGET_LW

for n,p in missing:
    attrs={'layer':LAYER,'linetype':linetype,'color':color,'lineweight':TARGET_LW,'ltscale':ltscale}
    msp.add_circle((p[0],p[1],0),radius,dxfattribs=attrs)
    verts=[(p[0]+x,p[1]+y) for x,y in offsets]
    msp.add_lwpolyline(verts,close=True,dxfattribs=attrs)

# Apply the explicit layer-width request to every top-level layer object.
for e in msp:
    if e.dxf.layer==LAYER and e.dxf.hasattr('lineweight'):
        e.dxf.lineweight=TARGET_LW

tmp=OUT.with_suffix('.repair.tmp.dxf')
doc.saveas(tmp)
tmp.replace(OUT)

# Reopen and audit written artifact.
check=ezdxf.readfile(OUT); cm=check.modelspace()
direct_circles=[e for e in cm.query('CIRCLE') if e.dxf.layer==LAYER]
remaining=[]
for n,p in nodes.items():
    direct_near=min((d(p,xy(e.dxf.center)) for e in direct_circles),default=1e9)
    block_near=min((d(p,xy(v.dxf.center)) for ins in cm.query('INSERT') if ins.dxf.layer==LAYER for v in ins.virtual_entities() if v.dxftype()=='CIRCLE'),default=1e9)
    if min(direct_near,block_near)>0.05: remaining.append(n)
wrong_lw=[e.dxf.handle for e in cm if e.dxf.layer==LAYER and e.dxf.hasattr('lineweight') and e.dxf.lineweight!=TARGET_LW]
result={'file':str(OUT),'source':str(DXF),'backup':str(BACKUP),'numbered_wells':len(nodes),'added_ugos':len(missing),'added_well_numbers':[n for n,_ in missing],'direct_ugos_added':len(missing),'circular_block_internal_width_mm':TARGET_LW/100,'remaining_wells_without_ugo':remaining,'top_level_layer_objects_wrong_lineweight':len(wrong_lw),'audit_errors':len(check.audit())}
(ROOT/'work/telecom_ugo_repair_result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
