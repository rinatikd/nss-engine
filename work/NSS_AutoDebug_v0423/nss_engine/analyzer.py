"""NSS Engine v0.21: read-only 2D network diagnostics core (stdlib)."""
from dataclasses import dataclass, asdict
from math import dist, hypot
from collections import defaultdict
import json

@dataclass(frozen=True)
class Segment:
    handle: str
    a: tuple[float, float]
    b: tuple[float, float]
    layer: str = 'NSS'

@dataclass(frozen=True)
class Well:
    handle: str
    point: tuple[float, float]


def _cross(a,b): return a[0]*b[1]-a[1]*b[0]
def _sub(a,b): return (a[0]-b[0],a[1]-b[1])
def _intersection(s,t,eps=1e-9):
    p=s.a; r=_sub(s.b,s.a); q=t.a; v=_sub(t.b,t.a)
    d=_cross(r,v)
    if abs(d)<eps: return None # collinear overlap handled separately
    u=_cross(_sub(q,p),r)/d; x=_cross(_sub(q,p),v)/d
    if -eps<=x<=1+eps and -eps<=u<=1+eps:
        return (p[0]+x*r[0],p[1]+x*r[1])
    return None

def _point_to_segment(p,s):
    v=_sub(s.b,s.a); w=_sub(p,s.a); vv=v[0]**2+v[1]**2
    if vv==0: return dist(p,s.a)
    t=max(0,min(1,(w[0]*v[0]+w[1]*v[1])/vv))
    return dist(p,(s.a[0]+t*v[0],s.a[1]+t*v[1]))

def analyze(segments, wells=(), utilities=(), tolerance=0.05, *, _endpoints_only=False):
    """Return findings. Coordinates must be in same planar drawing units; tolerance in those units."""
    if tolerance<=0: raise ValueError('tolerance must be positive')
    segments=list(segments); wells=list(wells); utilities=list(utilities)
    findings=[]
    def add(code,priority,handles,point,message,certainty='geometric_fact'):
        findings.append(dict(code=code,priority=priority,handles=list(handles),point=list(point),message=message,certainty=certainty))
    for s in segments:
        if dist(s.a,s.b)<=1e-9: add('ZERO_LENGTH','high',[s.handle],s.a,'Zero-length segment')
    # Endpoint clusters using a grid and union-find; avoids rounding boundary errors.
    endpoints=[(s.handle,k,p) for s in segments for k,p in [('a',s.a),('b',s.b)]]
    parent=list(range(len(endpoints)))
    def root(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]];i=parent[i]
        return i
    def union(i,j):
        a,b=root(i),root(j)
        if a!=b: parent[b]=a
    grid=defaultdict(list)
    from math import floor
    for i,(_,_,p) in enumerate(endpoints):
        cell=(floor(p[0]/tolerance),floor(p[1]/tolerance))
        for dx in (-1,0,1):
            for dy in (-1,0,1):
                for j in grid[(cell[0]+dx,cell[1]+dy)]:
                    if dist(p,endpoints[j][2])<=tolerance: union(i,j)
        grid[cell].append(i)
    groups=defaultdict(list)
    for i in range(len(endpoints)): groups[root(i)].append(i)
    for members in groups.values():
        if len(members)==1:
            h,_,p=endpoints[members[0]]
            add('OPEN_END','medium',[h],p,'Unconnected endpoint; verify intentional termination','candidate_issue')
    if _endpoints_only:
        return {'findings': findings}
    # Duplicate orientation-independent geometry within tolerance.
    for i,s in enumerate(segments):
        for t in segments[i+1:]:
            if (dist(s.a,t.a)<=tolerance and dist(s.b,t.b)<=tolerance) or (dist(s.a,t.b)<=tolerance and dist(s.b,t.a)<=tolerance):
                add('DUPLICATE_SEGMENT','high',[s.handle,t.handle],s.a,'Coincident segment geometry')
    for w in wells:
        if not any(_point_to_segment(w.point,s)<=tolerance for s in segments):
            add('UNCONNECTED_WELL','medium',[w.handle],w.point,'Well is not on recognized network','candidate_issue')
    for s in segments:
        for u in utilities:
            p=_intersection(s,u)
            if p is not None:
                add('UTILITY_CROSSING','info',[s.handle,u.handle],p,'Planar intersection only; clearance/depth not verified')
    return {'schema_version':'0.21','units':'drawing_units','tolerance':tolerance,'summary':{'segments':len(segments),'wells':len(wells),'utilities':len(utilities),'findings':len(findings)},'findings':findings}

def save_report(path,report):
    with open(path,'w',encoding='utf-8') as f: json.dump(report,f,ensure_ascii=False,indent=2)
