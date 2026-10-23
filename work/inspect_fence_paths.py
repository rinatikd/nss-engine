from pathlib import Path
import ezdxf,json,math
p=Path('work/CCTV_Source_v04.dxf');d=ezdxf.readfile(p);m=d.modelspace(); rows=[]
for e in m.query('LWPOLYLINE'):
 if 'ВОЛС_ограждение' in e.dxf.layer or 'огражд_терр' in e.dxf.layer.lower():
  pts=list(e.get_points('xy'));length=sum(math.hypot(b[0]-a[0],b[1]-a[1]) for a,b in zip(pts,pts[1:]))
  rows.append({'handle':e.dxf.handle,'layer':e.dxf.layer,'n':len(pts),'closed':e.closed,'length':round(length,2),'start':pts[0],'end':pts[-1],'near':[pt for pt in pts if math.hypot(pt[0]-6453.52,pt[1]+11189.14)<30]})
print(json.dumps(rows,ensure_ascii=True))
