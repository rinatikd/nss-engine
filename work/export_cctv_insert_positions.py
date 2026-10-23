from pathlib import Path
import ezdxf,json,math
p=Path('work/CCTV_Source_v04.dxf'); d=ezdxf.readfile(p); m=d.modelspace()
rows=[]
for layer in ['СВН_Тепловизоры','СВН_Камеры_периметр','СВН_Камеры_проезды','СВН_Шкафы_коммутационные']:
 es=m.query('*[layer=="%s"]'%layer)
 for e in es:
  if e.dxftype()!='INSERT': continue
  x,y=float(e.dxf.insert.x),float(e.dxf.insert.y); label=''
  for t in m.query('TEXT'):
   if t.dxf.layer==layer and abs(t.dxf.insert.x-x)<0.01 and abs(t.dxf.insert.y-y)<0.01: label=t.dxf.text;break
  rows.append({'layer':layer,'id':label,'x':round(x,2),'y':round(y,2),'rot':round(float(e.dxf.rotation),2),'block':e.dxf.name})
print(json.dumps(rows,ensure_ascii=True))
