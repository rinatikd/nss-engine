from pathlib import Path
import json,math
from shapely.geometry import Polygon,LineString,Point
from shapely.geometry.polygon import orient
root=Path(__file__).resolve().parents[2];g=json.loads((root/'output/CCTV_v08_review/plot_geometry.json').read_text(encoding='utf-8'));p=Polygon(g['fence']);area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(g['fence'],g['fence'][1:]+g['fence'][:1]))/2
poly=orient(p.buffer(.6,join_style=2),sign=1 if area>0 else -1);ring=LineString(poly.exterior.coords);L=ring.length
start=ring.project(Point(g['objects']['ТВ-08-01']['x'],g['objects']['ТВ-08-01']['y']));verts=sorted({ring.project(Point(q)) for q in poly.exterior.coords[:-1]});stations=[]
def pt(s):return ring.interpolate(s%L)
def visible(a,b):return a.distance(b)<=105 and LineString([a,b]).intersection(p.buffer(-.005)).length<.001
for j in range(34):
 a=start+j*L/34;b=a+L/34;inner=sorted(v+k*L for k in [-1,0,1,2] for v in verts if a+1e-6<v+k*L<b-1e-6);ss=[a]+inner+[b];n=len(ss);best=[999]*n;prev=[None]*n;best[0]=0
 for k in range(1,n):
  for i in range(k):
   if best[i]+1<best[k] and visible(pt(ss[i]),pt(ss[k])):best[k]=best[i]+1;prev[k]=i
 assert prev[-1] is not None
 path=[];k=n-1
 while k is not None:path.append(k);k=prev[k]
 path=path[::-1]
 stations.extend(ss[i] for i in path[:-1])
coords=[list(pt(s).coords)[0] for s in stations];result={'offset_m':.6,'count':len(coords),'base_count':34,'extra_corner_points':len(coords)-34,'positions':coords,'chainage_offset_boundary':stations,'max_next_distance_m':max(math.dist(a,b) for a,b in zip(coords,coords[1:]+coords[:1])),'all_next_visible_2d':all(visible(Point(a),Point(b)) for a,b in zip(coords,coords[1:]+coords[:1]))}
(root/'output/cctv_chain_candidate.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print({k:v for k,v in result.items() if k not in ['positions','chainage_offset_boundary']})
