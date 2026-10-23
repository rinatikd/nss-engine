from pathlib import Path
import ezdxf,json
p=Path('work/CCTV_Source_v04.dxf');d=ezdxf.readfile(p); m=d.modelspace();
for e in m.query('LWPOLYLINE'):
 if 'ВОЛС' in e.dxf.layer:
  pts=list(e.get_points('xyb')); print(json.dumps({'layer':e.dxf.layer,'n':len(pts),'closed':e.closed,'bulges':sum(bool(v[2]) for v in pts)},ensure_ascii=True))
