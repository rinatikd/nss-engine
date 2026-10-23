from pathlib import Path
import ezdxf,json,math
p=Path('work/CCTV_Source_v04.dxf'); d=ezdxf.readfile(p); m=d.modelspace(); ins=[e for e in m.query('INSERT[layer=="СВН_Тепловизоры"]')]
rows=[]
for t in m.query('TEXT[layer=="СВН_Тепловизоры"]'):
 x,y=t.dxf.insert.x,t.dxf.insert.y
 e=min(ins,key=lambda q:(q.dxf.insert.x-x)**2+(q.dxf.insert.y-y)**2)
 dist=math.hypot(e.dxf.insert.x-x,e.dxf.insert.y-y)
 rows.append([t.dxf.text,round(x,2),round(y,2),round(e.dxf.insert.x,2),round(e.dxf.insert.y,2),round(dist,2),round(e.dxf.rotation,2)])
Path('work/thermal_positions.json').write_text(json.dumps(rows,ensure_ascii=True,indent=2),encoding='utf8')
print(json.dumps([r for r in rows if '08-07' in r[0]],ensure_ascii=True))
