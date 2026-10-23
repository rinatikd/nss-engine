from pathlib import Path
import ezdxf,json
d=ezdxf.readfile(Path('work/CCTV_Source_v07.dxf'))
for lo in d.layouts:
    if lo.name.lower()=='model': continue
    rows=[]
    for e in lo:
        if e.dxftype()=='TEXT': s=e.dxf.text
        elif e.dxftype()=='MTEXT': s=e.text
        else: continue
        if s.strip(): rows.append({'xy':[round(e.dxf.insert.x,1),round(e.dxf.insert.y,1)],'layer':e.dxf.layer,'text':s[:200]})
    print(json.dumps({'layout':lo.name,'texts':rows},ensure_ascii=True))
