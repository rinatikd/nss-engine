from pathlib import Path
import ezdxf,json
p=Path('work/CCTV_Source_v05.dxf');d=ezdxf.readfile(p);out={}
for lo in d.layouts:
 if '05' not in lo.name:continue
 rows=[]
 for e in lo:
  if e.dxftype()=='TEXT':s=e.dxf.text
  elif e.dxftype()=='MTEXT':s=e.text
  else:continue
  rows.append([e.dxftype(),s])
 out[lo.name]=rows
Path('work/spec_text.json').write_text(json.dumps(out,ensure_ascii=True,indent=2),encoding='utf8')
