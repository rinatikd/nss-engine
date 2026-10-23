from pathlib import Path
import ezdxf,json
from collections import Counter
p=Path('work/CCTV_Source_v05.dxf');d=ezdxf.readfile(p);m=d.modelspace(); l='ТЕЛЕФОННАЯ_КАБЕЛЬНАЯ_КАНАЛИЗАЦИЯ'; ts=[e for e in m.query(f'MTEXT[layer=="{l}"]')]
c=Counter(e.text for e in ts)
print(json.dumps({'n':len(ts),'strings':c.most_common(40)},ensure_ascii=True))
