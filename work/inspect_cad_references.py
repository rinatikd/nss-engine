from pathlib import Path
from collections import Counter
import json
import ezdxf

ROOT = Path(__file__).resolve().parent
targets = [next(ROOT.glob('*из_архива.dxf')), next(ROOT.glob('*WordPark*.dxf'))]
reports=[]
for path in targets:
    doc=ezdxf.readfile(path)
    msp=doc.modelspace()
    layer_counts=Counter(e.dxf.layer for e in msp)
    inserts=Counter((e.dxf.layer,e.dxf.name) for e in msp.query('INSERT'))
    interesting=[n for n in layer_counts if any(w in n.lower() for w in ('камера','камер','освещ','опор','кабель','трасс','шкаф','свн','скуд','домоф','волс','труб','колод','фонарь','свет'))]
    insert_locations={}
    for layer_name in interesting:
        elems=[e for e in msp.query('INSERT') if e.dxf.layer==layer_name]
        if elems:
            insert_locations[layer_name]=[{'name':e.dxf.name,'x':round(e.dxf.insert.x,3),'y':round(e.dxf.insert.y,3),'rotation':round(e.dxf.rotation,2)} for e in elems]
    reports.append({
      'file':path.name,'version':doc.dxfversion,'model_entities':len(msp),'layouts':list(doc.layout_names()),
      'interesting_layers':{n:layer_counts[n] for n in interesting},
      'related_inserts':{f'{layer} / {name}':count for (layer,name),count in inserts.items() if layer in interesting},
      'insert_locations':insert_locations,
      'all_layers':[{'name':l.dxf.name,'lineweight':l.dxf.lineweight,'color':l.dxf.color} for l in doc.layers],
    })
out=ROOT/'cad_reference_audit.json'
out.write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf-8')
for r in reports:
    print(r['file'],r['version'],r['model_entities'],r['layouts'])
    print(json.dumps(r['interesting_layers'],ensure_ascii=False))
    print(json.dumps(r['related_inserts'],ensure_ascii=False))
