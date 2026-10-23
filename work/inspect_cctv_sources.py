from pathlib import Path
from collections import Counter
import ezdxf
files=[Path('work/CCTV_Source_v04.dxf'),Path('ГП_Виллы_12.10.26 для СС.dxf'),Path('ГП_Виллы_12.10.26 для СС_с_телефонной_канализацией.dxf'),*Path('work').glob('*Садик*из*архив*.dxf')]
for p in files:
 try:
  d=ezdxf.readfile(p); m=d.modelspace(); print('\nFILE',p.name,'entities',len(m))
  for layer in d.layers:
   n=layer.dxf.name
   if any(x in n.lower() for x in ('свет','опор','lighting','pole','перим','теплов','камер','шкаф','кабель','свн','камера')):
    es=m.query(f'*[layer=="{n}"]')
    if es:
     print('LAYER',repr(n),len(es),Counter(e.dxftype() for e in es))
     if 'Камеры' in n or 'Теплов' in n or 'опор' in n.lower() or 'свет' in n.lower():
      for e in es:
       if e.dxftype() in ('INSERT','POINT','CIRCLE'):
        print(' ',e.dxftype(),e.dxf.name if e.dxftype()=='INSERT' else '',tuple(round(v,2) for v in e.dxf.insert[:2] if 1) if e.dxftype()=='INSERT' else tuple(round(v,2) for v in e.dxf.center[:2]) if e.dxftype()=='CIRCLE' else tuple(round(v,2) for v in e.dxf.location[:2]))
 except Exception as ex: print('ERR',p,ex)
