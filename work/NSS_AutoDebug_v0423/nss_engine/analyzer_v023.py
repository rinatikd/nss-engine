"""v0.23 read-only topology diagnostics. 2D geometry only, no normative verdicts."""
from collections import defaultdict
from math import dist, floor, isfinite
from .analyzer import _intersection, _point_to_segment
from .spatial import SegmentGrid

def analyze(segments, wells=(), utilities=(), tolerance=.05, cell_size=10.):
    if not isfinite(tolerance) or tolerance <= 0: raise ValueError('invalid tolerance')
    segments=list(segments); wells=list(wells); utilities=list(utilities)
    handles=[s.handle for s in segments]
    if len(handles)!=len(set(handles)): raise ValueError('duplicate segment identifiers')
    for s in segments+utilities:
        if any(not isfinite(v) for p in (s.a,s.b) for v in p): raise ValueError('nonfinite coordinate')
    for w in wells:
        if any(not isfinite(v) for v in w.point): raise ValueError('nonfinite well coordinate')
    idx=SegmentGrid(segments,cell_size)
    parent=list(range(len(segments)))
    def root(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]];i=parent[i]
        return i
    def union(i,j):
        a,b=root(i),root(j)
        if a!=b: parent[b]=a
    findings=[]
    def add(code,priority,handles,point,message,certainty='candidate_issue'):
        findings.append(dict(code=code,priority=priority,handles=list(handles),point=list(point),message=message,certainty=certainty))
    # Indexed endpoint-to-segment connectivity also supports T junctions.
    by_identity={id(s):i for i,s in enumerate(segments)}
    connected_ends=set()
    for i,s in enumerate(segments):
        if dist(s.a,s.b)<=1e-9: add('ZERO_LENGTH','high',[s.handle],s.a,'Degenerate segment','geometric_fact')
        for k,p in enumerate((s.a,s.b)):
            for t in idx.candidates(p,p,tolerance):
                j=by_identity[id(t)]
                if i!=j and _point_to_segment(p,t)<=tolerance:
                    union(i,j);connected_ends.add((i,k))
    for i,s in enumerate(segments):
        for k,p in enumerate((s.a,s.b)):
            if (i,k) not in connected_ends:
                add('OPEN_END','medium',[s.handle],p,'Endpoint has no nearby network segment')
    for i,s in enumerate(segments):
        for t in idx.candidates(s.a,s.b,tolerance):
            j=by_identity[id(t)]
            if j<=i:continue
            if ((dist(s.a,t.a)<=tolerance and dist(s.b,t.b)<=tolerance) or
                (dist(s.a,t.b)<=tolerance and dist(s.b,t.a)<=tolerance)):
                add('DUPLICATE_SEGMENT','high',[s.handle,t.handle],s.a,'Same segment endpoints','geometric_fact')
    for w in wells:
        if not any(_point_to_segment(w.point,s)<=tolerance for s in idx.candidates(w.point,w.point,tolerance)):
            add('UNCONNECTED_WELL','medium',[w.handle],w.point,'Well is outside network tolerance')
    for u in utilities:
        for s in idx.candidates(u.a,u.b):
            p=_intersection(s,u)
            if p is not None:
                add('UTILITY_CROSSING','info',[s.handle,u.handle],p,'Plan crossing; Z and clearance unknown','geometric_fact')
    components=defaultdict(list)
    for i,s in enumerate(segments):components[root(i)].append(s.handle)
    ordered=sorted((sorted(v) for v in components.values()),key=lambda v:(v[0],len(v)))
    if len(ordered)>1:
        for component in ordered[1:]:
            add('DISCONNECTED_COMPONENT','medium',component,segments[handles.index(component[0])].a,'Separate 2D network component')
    findings.sort(key=lambda f:(f['code'],tuple(f['handles']),tuple(f['point'])))
    return {'schema_version':'0.23','units':'drawing_units','tolerance':tolerance,'cell_size':cell_size,
        'summary':{'segments':len(segments),'wells':len(wells),'utilities':len(utilities),'components':len(ordered),'findings':len(findings)},
        'components':[{'handles':c,'segment_count':len(c)} for c in ordered], 'findings':findings}
