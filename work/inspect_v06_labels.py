from pathlib import Path
import ezdxf,math
d=ezdxf.readfile(Path('work/CCTV_Source_v06.dxf'));m=d.modelspace()
for layer in ['СВН_Камеры_периметр','СВН_Камеры_проезды','СВН_Камеры_культуры','СВН_Камеры_купольные','СВН_Камеры_PTZ','СВН_Тепловизоры','СВН_Шкафы_коммутационные']:
    ins=list(m.query(f'INSERT[layer=="{layer}"]'))
    ts=[t for t in m.query('TEXT') if t.dxf.layer==layer]
    print('LAYER',layer,'inserts',len(ins),'texts',len(ts))
    for i in ins[:4]:
        t=min(ts,key=lambda t:math.hypot(t.dxf.insert.x-i.dxf.insert.x,t.dxf.insert.y-i.dxf.insert.y)) if ts else None
        if t: print(' ',i.dxf.name,round(i.dxf.insert.x,2),round(i.dxf.insert.y,2),round(i.dxf.rotation,2),'->',t.dxf.text,round(math.hypot(t.dxf.insert.x-i.dxf.insert.x,t.dxf.insert.y-i.dxf.insert.y),2))
