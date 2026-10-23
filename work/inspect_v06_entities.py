from pathlib import Path
from collections import Counter
import ezdxf, json

for p in [Path('work/CCTV_Source_v06.dxf'), Path('ГП_Виллы_12.10.26 для СС.dxf'), Path('work/23.07.2026г.-WordPark  ул. Е748  Сети ЭН-готов.dxf')]:
    if not p.exists():
        continue
    d=ezdxf.readfile(p); m=d.modelspace(); rows=[]
    for layer in d.layers:
        name=layer.dxf.name; es=m.query(f'*[layer=="{name}"]')
        if es and (p.name.startswith('CCTV') or any(k in name.lower() for k in ('lighting','pole','light','опор','свет','освещ','фонар','камера','свн','теплов','шкаф'))):
            rows.append({'layer':name,'n':len(es),'types':dict(Counter(e.dxftype() for e in es)),
                'inserts':dict(Counter(e.dxf.name for e in es if e.dxftype()=='INSERT'))})
    print(json.dumps({'file':str(p),'layers':rows},ensure_ascii=True))
    if p.name.startswith('CCTV'):
        for e in m.query('INSERT'):
            if 'CAM' in e.dxf.name.upper() or 'SVN' in e.dxf.name.upper() or 'CABINET' in e.dxf.name.upper():
                layer=e.dxf.layer
                texts=[t.dxf.text for t in m.query('TEXT') if t.dxf.layer==layer and abs(t.dxf.insert.x-e.dxf.insert.x)<.01 and abs(t.dxf.insert.y-e.dxf.insert.y)<.01]
                print(json.dumps({'layer':layer,'block':e.dxf.name,'xy':[e.dxf.insert.x,e.dxf.insert.y],'rot':e.dxf.rotation,'text':texts},ensure_ascii=True))
