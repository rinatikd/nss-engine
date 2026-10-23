from pathlib import Path
from collections import Counter
import json
import ezdxf

p=next(Path('work').glob('*WordPark*.dxf'))
d=ezdxf.readfile(p)
m=d.modelspace()
counts=Counter(e.dxf.layer for e in m)
layers=[n for n in counts if any(s in n.lower() for s in ('освещ','фонарь','светильник','питающ','опор'))]
out=[]
for name in layers:
    rows=[]; xs=[]; ys=[]
    for e in m:
        if e.dxf.layer!=name: continue
        typ=e.dxftype(); pts=[]
        if typ=='LINE': pts=[e.dxf.start,e.dxf.end]
        elif typ=='LWPOLYLINE': pts=[type('P',(),{'x':q[0],'y':q[1]}) for q in e.get_points('xy')]
        elif typ=='INSERT': pts=[e.dxf.insert]
        elif typ in ('CIRCLE','ARC'): pts=[e.dxf.center]
        elif typ=='POINT': pts=[e.dxf.location]
        if pts:
            xs.extend(q.x for q in pts); ys.extend(q.y for q in pts)
            row={'type':typ}
            if typ=='INSERT': row['block']=e.dxf.name
            row['pts']=[[round(q.x,3),round(q.y,3)] for q in pts[:8]]
            rows.append(row)
    out.append({'layer':name,'entity_count':counts[name],'extents':[min(xs),min(ys),max(xs),max(ys)] if xs else None,'sample':rows[:12]})
res={'file':p.name,'version':d.dxfversion,'entities':len(m),'layouts':list(d.layout_names()),'layer_summaries':out}
Path('work/wordpark_lighting_extract.json').write_text(json.dumps(res,ensure_ascii=False,indent=2),encoding='utf-8')
