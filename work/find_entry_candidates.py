from pathlib import Path
from math import dist, atan2
import ezdxf

d=ezdxf.readfile('work/CCTV_Source_v04.dxf')
m=d.modelspace()
def pts(e):
    if e.dxftype()=='LINE': return [(e.dxf.start.x,e.dxf.start.y),(e.dxf.end.x,e.dxf.end.y)]
    if e.dxftype()=='LWPOLYLINE': return [(x,y) for x,y in e.get_points('xy')]
    if e.dxftype()=='POLYLINE': return [(v.dxf.location.x,v.dxf.location.y) for v in e.vertices]
    return []
def leng(p): return sum(dist(a,b) for a,b in zip(p,p[1:]))
f=[]
for e in m:
    if e.dxf.layer=='К_Огражд_терр_проект' and e.dxftype() in ('LWPOLYLINE','POLYLINE'):
        p=pts(e); l=leng(p)
        if l>300 and min(x for x,y in p)>5300 and max(x for x,y in p)<6900: f.append((l,p))
F=min(f,key=lambda z:abs(z[0]-1969.7))[1]; B=min(f,key=lambda z:abs(z[0]-749.1))[1]; C=min(f,key=lambda z:abs(z[0]-467.6))[1]
route=[B[-1],F[0],*F[1:],C[0],*C[1:],B[0],*B[1:]]
def nearest(p):
    best=(1e99,None)
    for a,b in zip(route,route[1:]):
        vx,vy=b[0]-a[0],b[1]-a[1]; den=vx*vx+vy*vy
        if den==0: continue
        t=max(0,min(1,((p[0]-a[0])*vx+(p[1]-a[1])*vy)/den)); q=(a[0]+t*vx,a[1]+t*vy); dd=dist(p,q)
        if dd<best[0]: best=(dd,q)
    return best
rows=[]
for e in m:
    if e.dxf.layer!='П_Оси проездов' or e.dxftype() not in ('LWPOLYLINE','POLYLINE','LINE'): continue
    p=pts(e)
    if len(p)<2 or leng(p)<20: continue
    for end in (p[0],p[-1]):
        dd,q=nearest(end)
        if dd<40: rows.append((dd,end,q,leng(p)))
rows.sort(key=lambda r:r[0])
for dd,end,q,axis_len in rows: print('distance=%.1f axis_end=(%.1f, %.1f) fence=(%.1f, %.1f) axis_len=%.1f'%(dd,end[0],end[1],q[0],q[1],axis_len))
