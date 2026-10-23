from pathlib import Path
import ezdxf,json
from collections import Counter
p=Path('work/CCTV_Source_v05.dxf');d=ezdxf.readfile(p);m=d.modelspace();rows=[]
for e in m.query('INSERT'):
 x,y=e.dxf.insert.x,e.dxf.insert.y
 if 5200<x<6900 and -11400<y<-10300: rows.append([e.dxf.layer,e.dxf.name,round(x,1),round(y,1)])
print(json.dumps({'n':len(rows),'by':Counter((a,b) for a,b,_,_ in rows).most_common(30),'sample':rows[:30]},ensure_ascii=True))
