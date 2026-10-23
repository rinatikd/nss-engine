import ezdxf,json,math
from pathlib import Path
p=Path('work/CCTV_Source_v05.dxf');d=ezdxf.readfile(p);m=d.modelspace(); layer='ТЕЛЕФОННАЯ_КАБЕЛЬНАЯ_КАНАЛИЗАЦИЯ'; rows=[]
for e in m.query('*[layer=="%s"]'%layer):
 t=e.dxftype();xs=[];ys=[]
 if t=='LINE':ps=[e.dxf.start,e.dxf.end]
 elif t=='LWPOLYLINE':ps=list(e.get_points('xy'))
 elif t=='ARC' or t=='CIRCLE':ps=[e.dxf.center]
 elif t=='INSERT':ps=[e.dxf.insert]
 elif t=='MTEXT' or t=='TEXT':ps=[e.dxf.insert]
 else: ps=[]
 for p in ps:xs.append(p[0] if not hasattr(p,'x') else p.x);ys.append(p[1] if not hasattr(p,'y') else p.y)
 if xs:rows.append([t,e.dxf.handle,min(xs),min(ys),max(xs),max(ys)])
print(json.dumps({'n':len(rows),'extents':[min(r[2] for r in rows),min(r[3] for r in rows),max(r[4] for r in rows),max(r[5] for r in rows)],'types':{t:sum(r[0]==t for r in rows) for t in set(r[0] for r in rows)},'inrange':[r for r in rows if 5000<r[2]<7000 and -11400<r[3]<-10300][:20]},ensure_ascii=True))
