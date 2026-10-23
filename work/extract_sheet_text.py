from pathlib import Path
import ezdxf,json
p=Path('work/CCTV_Source_v05.dxf');d=ezdxf.readfile(p);out={}
for lo in d.layouts:
 if lo.name=='Model':continue
 rows=[]
 for e in lo:
  if e.dxftype()=='TEXT':s=e.dxf.text
  elif e.dxftype()=='MTEXT':s=e.text
  else:continue
  if any(k in s.lower() for k in ('67','38','134','172','теплов','камер','опор','кабел','размещ','зон')): rows.append([e.dxftype(),s[:300]])
 out[lo.name]=rows
Path('work/cctv_sheet_relevant_text.json').write_text(json.dumps(out,ensure_ascii=True,indent=2),encoding='utf8')
