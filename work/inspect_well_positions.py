from pathlib import Path
import ezdxf,json,math
p=Path('work/CCTV_Source_v05.dxf');d=ezdxf.readfile(p);m=d.modelspace();well=[e for e in m.query('INSERT') if e.dxf.layer=='ТЕЛЕФОННАЯ_КАБЕЛЬНАЯ_КАНАЛИЗАЦИЯ' and e.dxf.name==chr(0x432)+'0'];out=[]
for e in well[:20]:out.append([round(e.dxf.insert.x,2),round(e.dxf.insert.y,2),e.dxf.handle,e.dxf.name])
print(json.dumps({'n':len(well),'minx':min(e.dxf.insert.x for e in well),'maxx':max(e.dxf.insert.x for e in well),'miny':min(e.dxf.insert.y for e in well),'maxy':max(e.dxf.insert.y for e in well),'sample':out},ensure_ascii=True))
