from pathlib import Path
import ezdxf,json
p=Path('work/CCTV_Source_v05.dxf');d=ezdxf.readfile(p);m=d.modelspace(); rows=[]
for layer in ['СВН_Камеры_периметр','СВН_Тепловизоры','СВН_Камеры_проезды','СВН_Шкафы_коммутационные']:
 es=m.query('*[layer=="%s"]'%layer)
 text=[e for e in es if e.dxftype()=='TEXT']; inserts=[e for e in es if e.dxftype()=='INSERT']
 rows.append({'layer':layer,'text':[[e.dxf.text,round(e.dxf.insert.x,1),round(e.dxf.insert.y,1)] for e in text[:10]],'ins':[[round(e.dxf.insert.x,1),round(e.dxf.insert.y,1),round(e.dxf.rotation,1)] for e in inserts[:10]]})
print(json.dumps(rows,ensure_ascii=True))
