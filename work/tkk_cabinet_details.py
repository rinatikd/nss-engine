from pathlib import Path
from collections import Counter
import ezdxf,json
p=Path('work/CCTV_Source_v04.dxf');d=ezdxf.readfile(p);m=d.modelspace();out={}
for layer in ['СВН_Шкафы_коммутационные','ТЕЛЕФОННАЯ_КАБЕЛЬНАЯ_КАНАЛИЗАЦИЯ']:
 es=m.query('*[layer=="%s"]'%layer)
 out[layer]={'types':dict(Counter(e.dxftype() for e in es)),'inserts':dict(Counter(e.dxf.name for e in es if e.dxftype()=='INSERT')),'text':[e.dxf.text for e in es if e.dxftype()=='TEXT'][:40]}
Path('work/tkk_cabinet_details.json').write_text(json.dumps(out,ensure_ascii=True,indent=2),encoding='utf8')
