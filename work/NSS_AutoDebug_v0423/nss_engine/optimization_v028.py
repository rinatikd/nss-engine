"""Conceptual multi-criteria routing on v0.27 lattice; not a design approval."""
from dataclasses import dataclass
import heapq
import math
from .routing_v027 import Rect

@dataclass(frozen=True)
class Weights:
    length: float = 1.0
    bends: float = 0.0
    soft_zone: float = 0.0
    def __post_init__(self):
        if not all(type(v) in (int,float) and math.isfinite(v) and v >= 0 for v in (self.length,self.bends,self.soft_zone)) or self.length <= 0:
            raise ValueError('weights must be finite, nonnegative; length positive')

@dataclass(frozen=True)
class Candidate:
    status: str
    points: tuple
    length: float
    bends: int
    soft_zone_length: float
    score: float
    expanded: int
    reason: str = ''


def optimize(start, goal, obstacles=(), soft_zones=(), *, weights=Weights(), step=1.0,
             clearance=0.0, margin=10.0, max_cells=250000):
    """Route with orthogonal steps. Soft-zone exposure is exact union length along orthogonal grid edges.

    Units and cost coefficients are user-provided, not legal minimum distances.
    """
    if len(start)!=2 or len(goal)!=2 or not all(type(v) in (int,float) and math.isfinite(v) for v in (*start,*goal)):
        raise ValueError('invalid endpoints')
    if not all(type(v) in (int,float) and math.isfinite(v) for v in (step,clearance,margin)) or step<=0 or clearance<0 or margin<0 or type(max_cells) is not int or max_cells<1:
        raise ValueError('invalid parameters')
    obstacles=tuple(obstacles);soft_zones=tuple(soft_zones)
    if not all(isinstance(r,Rect) for r in (*obstacles,*soft_zones)):
        raise ValueError('zones must be Rect instances')
    x0,y0=start
    target=(round((goal[0]-x0)/step),round((goal[1]-y0)/step))
    if math.dist((x0+target[0]*step,y0+target[1]*step),goal)>step*1e-7:
        return Candidate('UNSUPPORTED',(),0,0,0,0,0,'goal is not on the grid')
    xs=[start[0],goal[0]];ys=[start[1],goal[1]]
    for r in obstacles:xs.extend((r.xmin,r.xmax));ys.extend((r.ymin,r.ymax))
    lx=math.floor((min(xs)-clearance-margin-x0)/step);hx=math.ceil((max(xs)+clearance+margin-x0)/step)
    ly=math.floor((min(ys)-clearance-margin-y0)/step);hy=math.ceil((max(ys)+clearance+margin-y0)/step)
    if (hx-lx+1)*(hy-ly+1)>max_cells:
        return Candidate('LIMIT',(),0,0,0,0,0,'grid exceeds max_cells')
    def pt(n):return (x0+n[0]*step,y0+n[1]*step)
    def inside(r,x,y):return r.xmin<=x<=r.xmax and r.ymin<=y<=r.ymax
    def blocked(a,b):
        ax,ay=pt(a);bx,by=pt(b)
        for r in obstacles:
            l=r.xmin-clearance;h=r.xmax+clearance;t=r.ymin-clearance;u=r.ymax+clearance
            if ax==bx and l<=ax<=h and max(min(ay,by),t)<=min(max(ay,by),u):return True
            if ay==by and t<=ay<=u and max(min(ax,bx),l)<=min(max(ax,bx),h):return True
        return False
    origin=(0,0)
    if blocked(origin,origin) or blocked(target,target):return Candidate('BLOCKED',(),0,0,0,0,0,'endpoint blocked')
    if origin==target:return Candidate('OK',(start,),0,0,0,0,0)
    dirs=((1,0),(0,1),(-1,0),(0,-1))
    first=(origin,-1)
    best={first:0.0};metrics={first:(0,0,0.0)};parent={}
    h=lambda n:weights.length*step*(abs(n[0]-target[0])+abs(n[1]-target[1]))
    heap=[(h(origin),0.0,origin,-1)];expanded=0
    while heap:
        _,cost,node,prevdir=heapq.heappop(heap)
        state=(node,prevdir)
        if cost!=best.get(state,math.inf):continue
        expanded+=1
        if node==target:
            path=[state]
            while path[-1]!=first:path.append(parent[path[-1]])
            path.reverse()
            length,bends,soft=metrics[state]
            return Candidate('OK',tuple(pt(n) for n,_ in path),length,bends,soft,cost,expanded)
        for d,(dx,dy) in enumerate(dirs):
            nxt=(node[0]+dx,node[1]+dy)
            if not(lx<=nxt[0]<=hx and ly<=nxt[1]<=hy) or blocked(node,nxt):continue
            a=pt(node);b=pt(nxt);mx=(a[0]+b[0])/2;my=(a[1]+b[1])/2
            exposed=exposure_length(a,b,soft_zones)
            turn=int(prevdir!=-1 and prevdir!=d)
            ng=cost+weights.length*step+weights.bends*turn+weights.soft_zone*exposed
            ns=(nxt,d)
            if ng<best.get(ns,math.inf):
                best[ns]=ng;parent[ns]=state
                oldlen,oldbends,oldsoft=metrics[state]
                metrics[ns]=(oldlen+step,oldbends+turn,oldsoft+exposed)
                heapq.heappush(heap,(ng+h(nxt),ng,nxt,d))
    return Candidate('NO_ROUTE',(),0,0,0,0,expanded,'no feasible route')


def exposure_length(a,b,zones):
    """Exact union length of closed axis-aligned zone intervals along an orthogonal edge."""
    axis=0 if a[1]==b[1] else 1
    low,high=sorted((a[axis],b[axis]));fixed=a[1-axis];intervals=[]
    for r in zones:
        lo,hi,flo,fhi=(r.xmin,r.xmax,r.ymin,r.ymax) if axis==0 else (r.ymin,r.ymax,r.xmin,r.xmax)
        if flo<=fixed<=fhi:
            l,h=max(low,lo),min(high,hi)
            if l<h:intervals.append((l,h))
    total=0.;end=-math.inf
    for l,h in sorted(intervals):
        total+=max(0,h-max(l,end));end=max(end,h)
    return total


def compare(start,goal,obstacles=(),soft_zones=(),*,profiles=None,**kwargs):
    """Compare explicit engineer-defined weight profiles; never label one as approved."""
    if profiles is None:
        profiles={'shortest':Weights(1,0,0),'few_bends':Weights(1,3,0),
                  'avoid_soft_zones':Weights(1,0,5),'balanced':Weights(1,2,3)}
    results={name:optimize(start,goal,obstacles,soft_zones,weights=w,**kwargs) for name,w in profiles.items()}
    return {name:{'status':r.status,'points':[list(p) for p in r.points],
                  'length':r.length,'bends':r.bends,'soft_zone_length':r.soft_zone_length,
                  'weighted_score':r.score,'expanded':r.expanded,'reason':r.reason,
                  'weights':vars(profiles[name])} for name,r in results.items()}
