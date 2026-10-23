from pathlib import Path
from collections import Counter
import ezdxf,json
for p in [Path('work/CCTV_Source_v04.dxf'),Path('ГП_Виллы_12.10.26 для СС.dxf'),Path('ГП_Виллы_12.10.26 для СС_с_телефонной_канализацией.dxf')]:
 d=ezdxf.readfile(p);m=d.modelspace(); rows=[]
 for layer in d.layers:
  n=layer.dxf.name; es=m.query('*[layer=="%s"]'%n)
  if es and any(k in n.lower() for k in ('свет','опор','lighting','pole','камер','шкаф','свн','теплов','освещ')):
   rows.append({'layer':n,'count':len(es),'types':dict(Counter(e.dxftype() for e in es)),'sample':[(e.dxftype(),e.dxf.name if e.dxftype()=='INSERT' else '',[round(float(e.dxf.insert.x),2),round(float(e.dxf.insert.y),2)] if e.dxftype()=='INSERT' else None) for e in list(es)[:4]]})
 print(json.dumps({'file':p.name,'msp':len(m),'layers':rows},ensure_ascii=True))

