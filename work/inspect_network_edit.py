from pathlib import Path
from collections import Counter
import ezdxf

root=Path.cwd(); downloads=Path.home()/'Downloads'
src=ezdxf.readfile(next(downloads.glob('*20.10.26.dxf')),encoding='utf-8')
out=ezdxf.readfile(next(root.glob('*\u0442\u0435\u043b\u0435\u0444\u043e\u043d\u043d\u043e\u0439_\u043a\u0430\u043d\u0430\u043b\u0438\u0437\u0430\u0446\u0438\u0435\u0439.dxf')),encoding='utf-8')
key='\u041f\u0420_\u0422\u0415\u041b\u0415\u0424\u041e\u041d\u041d\u0410\u042f_\u041a\u0410\u041d\u0410\u041b\u0418\u0417\u0410\u0426\u0418\u042f'.casefold()
outkey=next(x.dxf.name for x in out.layers if '\u0442\u0435\u043b\u0435\u0444\u043e\u043d' in x.dxf.name.casefold())
for doc,label in [(src,'SOURCE'),(out,'OUTPUT')]:
    print('\n',label)
    layers=Counter(e.dxf.layer for e in doc.modelspace())
    for layer,n in layers.items():
        if any(k in layer.casefold() for k in ('\u0442\u0435\u043b\u0435\u0444\u043e\u043d','\u043a\u0430\u0431\u0435\u043b\u0438_\u0441\u0432\u044f\u0437\u0438','\u043a\u043e\u043b\u043e\u0434\u0446\u044b','\u043d\u0441\u0441')): print(layer.encode('unicode_escape').decode(),n)
    layerkey=key if label=='SOURCE' else outkey
    ents=[e for e in doc.modelspace() if e.dxf.layer.casefold()==layerkey.casefold()]
    print('conduit_layer_entities',Counter(e.dxftype() for e in ents))
    wells=[e for e in doc.modelspace().query('INSERT') if e.dxf.layer.casefold()==layerkey.casefold()]
    print('INSERTS',len(wells))
    for e in wells:
        attrs=[]
        for a in getattr(e,'attribs',[]): attrs.append((a.dxf.tag,a.dxf.text))
        print('INS',e.dxf.name,tuple(e.dxf.insert)[:2],attrs)
    print('TEXTS')
    for e in ents:
        if e.dxftype()=='MTEXT': print('MT',tuple(e.dxf.insert)[:2],e.plain_text().replace('\n',' | ')[:120])
    print('CURVES')
    for e in ents:
        if e.dxftype() in ('LINE','LWPOLYLINE','ARC'):
            if e.dxftype()=='LINE': geom=(tuple(e.dxf.start)[:2],tuple(e.dxf.end)[:2])
            elif e.dxftype()=='LWPOLYLINE': geom=[tuple(p[:2]) for p in e.get_points('xy')]
            else: geom=(tuple(e.dxf.center)[:2],e.dxf.radius,e.dxf.start_angle,e.dxf.end_angle)
            print(e.dxftype(),e.dxf.handle,geom)
