from pathlib import Path
import ezdxf,json
p=Path('work/CCTV_Source_v05.dxf');d=ezdxf.readfile(p);lo=next(l for l in d.layouts if '05_' in l.name);rows=[]
for e in lo:
 if e.dxftype()=='TEXT' and e.dxf.text.strip().isdigit(): rows.append([e.dxf.text,round(e.dxf.insert.x,2),round(e.dxf.insert.y,2)])
print(json.dumps(rows,ensure_ascii=True))
