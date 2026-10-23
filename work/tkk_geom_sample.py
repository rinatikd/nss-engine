from pathlib import Path
import ezdxf,json
p=Path('work/CCTV_Source_v04.dxf');d=ezdxf.readfile(p);m=d.modelspace();layer='ТЕЛЕФОННАЯ_КАБЕЛЬНАЯ_КАНАЛИЗАЦИЯ'; out=[]
for e in m.query('*[layer=="%s"]'%layer):
 if e.dxftype()=='MTEXT':out.append(['MTEXT',e.text[:100],round(e.dxf.insert.x,2),round(e.dxf.insert.y,2)])
 elif e.dxftype()=='INSERT':out.append(['INSERT',e.dxf.name,round(e.dxf.insert.x,2),round(e.dxf.insert.y,2)])
Path('work/tkk_geom_sample.json').write_text(json.dumps(out,ensure_ascii=True,indent=2),encoding='utf8')
