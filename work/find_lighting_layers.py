from pathlib import Path
import ezdxf,json
from collections import Counter
for p in [Path.cwd()/'ГП_Виллы_12.10.26 для СС.dxf',Path.cwd()/'ГП_Виллы_12.10.26 для СС_с_телефонной_канализацией.dxf']:
 d=ezdxf.readfile(p);m=d.modelspace();ls=[]
 for l in d.layers:
  n=l.dxf.name; es=m.query('*[layer=="%s"]'%n)
  if es and any(s in n.lower() for s in ('свет','опор','фонар','освещ','эом','наруж')): ls.append([n,len(es),dict(Counter(e.dxftype() for e in es))])
 print(json.dumps({'file':p.name,'layers':ls},ensure_ascii=True))
