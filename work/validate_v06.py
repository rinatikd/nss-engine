from pathlib import Path
import ezdxf,math,json
p=Path('work/CCTV_Source_v06.dxf');d=ezdxf.readfile(p);m=d.modelspace();t=[x for x in m.query('TEXT[layer=="СВН_Тепловизоры"]') if x.dxf.text.endswith('08-07')];ins=[x for x in m.query('INSERT[layer=="СВН_Тепловизоры"]')]
rows=[]
for x in t:
 i=min(ins,key=lambda q:math.hypot(q.dxf.insert.x-x.dxf.insert.x,q.dxf.insert.y-x.dxf.insert.y));rows.append({'id':x.dxf.text,'text_xy':[round(x.dxf.insert.x,2),round(x.dxf.insert.y,2)],'cam_xy':[round(i.dxf.insert.x,2),round(i.dxf.insert.y,2)],'rotation':round(i.dxf.rotation,2)})
f=[e for e in m.query('LWPOLYLINE') if 'ВОЛС_ограждение' in e.dxf.layer and e.closed][0];pts=[(q[0],q[1]) for q in f.get_points('xy')];best=(1e9,None)
for a,b in zip(pts,pts[1:]+pts[:1]):
 dx=b[0]-a[0];dy=b[1]-a[1];den=dx*dx+dy*dy;t0=max(0,min(1,((rows[0]['cam_xy'][0]-a[0])*dx+(rows[0]['cam_xy'][1]-a[1])*dy)/den));q=(a[0]+t0*dx,a[1]+t0*dy);dist=math.hypot(q[0]-rows[0]['cam_xy'][0],q[1]-rows[0]['cam_xy'][1])
 if dist<best[0]:best=(dist,math.degrees(math.atan2(dy,dx)))
print(json.dumps({'tv08_07':rows,'nearest_fence_distance_m':best[0],'tangent_angle_deg':best[1],'fixed_n':len(list(m.query('INSERT[layer=="СВН_Камеры_периметр"]'))),'thermal_n':len(ins),'pnd_n':len(list(m.query('LWPOLYLINE[layer=="СВН_Труба_ПНД_к_шкафам"]')))},ensure_ascii=True))
