from pathlib import Path
from collections import Counter
import json
import ezdxf
from ezdxf import bbox

p = next(x for x in Path('work').glob('*.dxf') if 'из_архива' in x.name)
d = ezdxf.readfile(p)
m = d.modelspace()
relevant_layers = [l.dxf.name for l in d.layers if any(s in l.dxf.name.lower() for s in ('камера', 'свн', 'скуд', 'шкаф', 'кабел', 'вн_'))]
layer_counts = {layer: len(m.query(f'*[layer=="{layer}"]')) for layer in relevant_layers}
inserts = Counter((e.dxf.layer, e.dxf.name) for e in m.query('INSERT') if e.dxf.layer in relevant_layers)
blocks = {}
block_text = {}
block_extents = {}
insert_samples = {}
for (layer, name), count in inserts.items():
    if name in d.blocks:
        blocks[f'{layer} / {name} x{count}'] = Counter(e.dxftype() for e in d.blocks[name])
        block_text[f'{layer} / {name}'] = [e.dxf.text for e in d.blocks[name] if e.dxftype() == 'TEXT']
        b=bbox.extents(d.blocks[name],fast=True)
        block_extents[f'{layer} / {name}']=[round(v,3) for v in (b.extmin.x,b.extmin.y,b.extmax.x,b.extmax.y)] if b.has_data else None
        ref=next(e for e in d.modelspace().query('INSERT') if e.dxf.layer==layer and e.dxf.name==name)
        insert_samples[f'{layer} / {name}']={'insert':[round(ref.dxf.insert.x,3),round(ref.dxf.insert.y,3)],'xscale':ref.dxf.xscale,'yscale':ref.dxf.yscale,'rotation':ref.dxf.rotation}
named = [n for n in d.blocks.block_names() if any(s in n.lower() for s in ('камера','домоф','вызыв','телефон','скуд','считыв','контрол','шлагбаум','шкаф'))]
out = {'file': p.name, 'layers': layer_counts, 'insert_blocks': {f'{k[0]} / {k[1]}':v for k,v in inserts.items()}, 'block_geometry': {k: dict(v) for k,v in blocks.items()}, 'block_text':block_text,'block_extents':block_extents,'insert_samples':insert_samples, 'named_blocks':named}
Path('work/sadik_ss_symbols.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
