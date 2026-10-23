from pathlib import Path
import ezdxf,math,json
p=Path('work/CCTV_Source_v05.dxf');d=ezdxf.readfile(p);m=d.modelspace();x,y=5524.57,-10939.02;out=[]
for e in m:
 if e.dxf.layer!='ТЕЛЕФОННАЯ_КАБЕЛЬНАЯ_КАНАЛИЗАЦИЯ':continue
 ps=[]
 if e.dxftype()=='LINE':ps=[(e.dxf.start.x,e.dxf.start.y),(e.dxf.end.x,e.dxf.end.y)]
 elif e.dxftype()=='LWPOLYLINE':ps=[(q[0],q[1]) for q in e.get_points('xy')]
 elif e.dxftype()=='ARC':ps=[(e.dxf.center.x,e.dxf.center.y)]
 else:continue
 for j,(a,b) in enumerate(zip(ps,ps[1:])):
  dx=b[0]-a[0];dy=b[1]-a[1];den=dx*dx+dy*dy
  if not den:continue
  t=max(0,min(1,((x-a[0])*dx+(y-a[1])*dy)/den));q=(a[0]+t*dx,a[1]+t*dy);dist=math.hypot(q[0]-x,q[1]-y)
  out.append([round(dist,2),e.dxftype(),e.dxf.handle,[round(q[0],1),round(q[1],1)],[round(a[0],1),round(a[1],1)],[round(b[0],1),round(b[1],1)]])
out.sort(key=lambda a:a[0]);print(json.dumps(out[:12],ensure_ascii=True))
