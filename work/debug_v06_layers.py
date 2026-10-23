import ezdxf,json
from pathlib import Path
p=Path('work/CCTV_Source_v06.dxf');d=ezdxf.readfile(p);m=d.modelspace();out=[]
for l in d.layers:
 n=l.dxf.name
 if 'Зоны' in n or 'PTZ' in n or 'Опоры' in n or 'ПНД' in n:
  out.append([n,len(m.query('*[layer=="%s"]'%n)),list(n.encode('unicode_escape'))[:5]])
print(json.dumps(out,ensure_ascii=True))
