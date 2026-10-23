"""Deterministic grid A* conceptual routing. Units are drawing units; no regulatory claims."""
from dataclasses import dataclass
import heapq
import math

@dataclass(frozen=True)
class Rect:
    xmin: float
    ymin: float
    xmax: float
    ymax: float
    def __post_init__(self):
        if not all(type(v) in (int,float) and math.isfinite(v) for v in (self.xmin,self.ymin,self.xmax,self.ymax)) or self.xmin>self.xmax or self.ymin>self.ymax:
            raise ValueError('invalid obstacle rectangle')

@dataclass(frozen=True)
class RouteResult:
    status: str
    points: tuple
    length: float
    expanded: int
    reason: str

def route(start, goal, obstacles=(), *, step=1.0, clearance=0.0, margin=10.0, max_cells=250000):
    """Orthogonal A* route on a finite lattice anchored at start.

    Obstacles are closed rectangles expanded by clearance. Candidate edges are
    checked against rectangles to prevent traversal through thin obstacles.
    This is a conceptual 2D route only, not a constructible or approved design.
    """
    if len(start)!=2 or len(goal)!=2 or not all(type(v) in (int,float) and math.isfinite(v) for v in (*start,*goal)):
        raise ValueError('invalid endpoints')
    if not all(type(v) in (int,float) and math.isfinite(v) for v in (step,clearance,margin)) or step<=0 or clearance<0 or margin<0 or type(max_cells) is not int or max_cells<1:
        raise ValueError('invalid routing parameters')
    obstacles=tuple(obstacles)
    if not all(isinstance(r,Rect) for r in obstacles):raise ValueError('obstacles must be Rect instances')
    x0,y0=start
    target=(round((goal[0]-x0)/step),round((goal[1]-y0)/step))
    # Do not silently snap the requested destination to another coordinate.
    if math.dist((x0+target[0]*step,y0+target[1]*step),goal)>step*1e-7:
        return RouteResult('UNSUPPORTED',(),0.0,0,'goal is not on the start-anchored grid')
    xs=[start[0],goal[0]];ys=[start[1],goal[1]]
    for r in obstacles: xs.extend((r.xmin,r.xmax));ys.extend((r.ymin,r.ymax))
    lo_x=math.floor((min(xs)-clearance-margin-x0)/step);hi_x=math.ceil((max(xs)+clearance+margin-x0)/step)
    lo_y=math.floor((min(ys)-clearance-margin-y0)/step);hi_y=math.ceil((max(ys)+clearance+margin-y0)/step)
    if (hi_x-lo_x+1)*(hi_y-lo_y+1)>max_cells:
        return RouteResult('LIMIT',(),0.0,0,'search grid exceeds max_cells')
    def pt(n):return (x0+n[0]*step,y0+n[1]*step)
    def blocked(a,b):
        ax,ay=pt(a);bx,by=pt(b)
        for r in obstacles:
            l=r.xmin-clearance;t=r.ymin-clearance;h=r.xmax+clearance;u=r.ymax+clearance
            if ax==bx:
                if l<=ax<=h and max(min(ay,by),t)<=min(max(ay,by),u):return True
            elif ay==by:
                if t<=ay<=u and max(min(ax,bx),l)<=min(max(ax,bx),h):return True
        return False
    origin=(0,0)
    if blocked(origin,origin) or blocked(target,target):return RouteResult('BLOCKED',(),0.0,0,'endpoint inside obstacle clearance')
    if origin==target:return RouteResult('OK',(start,),0.0,0,'')
    heuristic=lambda p:abs(p[0]-target[0])+abs(p[1]-target[1])
    heap=[(heuristic(origin),0,origin)];best={origin:0};parents={};expanded=0
    while heap:
        _,g,node=heapq.heappop(heap)
        if g!=best.get(node):continue
        expanded+=1
        if node==target:
            path=[node]
            while path[-1]!=origin:path.append(parents[path[-1]])
            path.reverse()
            return RouteResult('OK',tuple(pt(p) for p in path),g*step,expanded,'')
        for dx,dy in ((1,0),(0,1),(-1,0),(0,-1)):
            nxt=(node[0]+dx,node[1]+dy)
            if not (lo_x<=nxt[0]<=hi_x and lo_y<=nxt[1]<=hi_y) or blocked(node,nxt):continue
            ng=g+1
            if ng<best.get(nxt,math.inf):
                best[nxt]=ng;parents[nxt]=node
                heapq.heappush(heap,(ng+heuristic(nxt),ng,nxt))
    return RouteResult('NO_ROUTE',(),0.0,expanded,'no feasible route in search bounds')

def report(result):
    return {'status':result.status,'points':[list(p) for p in result.points],
            'length':result.length,'expanded':result.expanded,'reason':result.reason,
            'note':'2D conceptual screening only; no verified Kazakhstan design rules'}
