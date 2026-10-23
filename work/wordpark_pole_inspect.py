from pathlib import Path
import ezdxf,json
from collections import Counter
p=next(Path('work').glob('*WordPark*.dxf'));d=ezdxf.readfile(p);m=d.modelspace();out=[]
for l in d.layers:
 n=l.dxf.name;es=m.query('*[layer=="%s"]'%n)
 if es and any(k in n.lower() for k in ('опор','свет','освещ','фонар')):
  out.append({'layer':n,'count':len(es),'types':dict(Counter(e.dxftype() for e in es)),'inserts':dict(Counter(e.dxf.name for e in es if e.dxftype()=='INSERT'))})
print(json.dumps({'file':p.name,'layers':out},ensure_ascii=True))
