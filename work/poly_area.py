from pathlib import Path
import ezdxf
p=Path('work/CCTV_Source_v04.dxf');d=ezdxf.readfile(p)
for e in d.modelspace().query('LWPOLYLINE'):
 if 'ВОЛС_ограждение' in e.dxf.layer:
  pts=[(q[0],q[1]) for q in e.get_points('xy')]; area=sum(x1*y2-x2*y1 for (x1,y1),(x2,y2) in zip(pts,pts[1:]))/2
  print('area',area,'ccw',area>0)
