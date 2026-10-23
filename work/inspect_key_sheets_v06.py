from pathlib import Path
import ezdxf,json,re
p=Path('work/CCTV_Source_v06.dxf');d=ezdxf.readfile(p);out={}
for l in d.layouts:
 if any(x in l.name for x in ('01_','05_','06_')):
  rows=[]
  for e in l:
   s=e.dxf.text if e.dxftype()=='TEXT' else e.text if e.dxftype()=='MTEXT' else ''
   if s and (re.search(r'67|38|134|172|60|178|35\.4|35\.9|154|120|58,5|196',s) or 'DS-2TD' in s or 'DORI Detect' in s or 'ПНД' in s or 'ОС —' in s):rows.append(s)
  out[l.name]=rows
Path('work/key_sheets_v06.json').write_text(json.dumps(out,ensure_ascii=True,indent=2),encoding='utf8')
