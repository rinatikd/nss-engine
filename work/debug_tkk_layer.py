import ezdxf,json
from pathlib import Path
from collections import Counter
for fn in ['work/CCTV_Source_v05.dxf','work/CCTV_Source_v04.dxf']:
 d=ezdxf.readfile(fn);m=d.modelspace(); x=[]
 for l in d.layers:
  if 'КАНАЛИЗАЦИЯ' in l.dxf.name.upper() or 'телефон' in l.dxf.name.lower():
   es=m.query('*[layer=="%s"]'%l.dxf.name)
   x.append([l.dxf.name,len(es),[[k,v] for k,v in Counter((e.dxftype(),getattr(e.dxf,'name','')) for e in es).items()]])
 print(json.dumps([fn,x],ensure_ascii=True))

