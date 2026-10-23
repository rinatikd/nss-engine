"""NSS v0.24: read-only, 2D connectivity with explicit junction policy."""
from collections import defaultdict
from math import dist, isfinite
from .analyzer import _intersection, _point_to_segment
from .analyzer_v023 import analyze as legacy_analyze
from .spatial import SegmentGrid

def analyze(segments, wells=(), utilities=(), tolerance=0.05, cell_size=10.0, junction_policy='endpoints_and_wells'):
    """Crossing interiors are NOT connected. Wells connect segments only if within tolerance.
    'endpoints_only' ignores wells for connectivity; 'endpoints_and_wells' uses them.
    """
    if junction_policy not in ('endpoints_only','endpoints_and_wells'): raise ValueError('invalid junction policy')
    if not isfinite(tolerance) or tolerance<=0: raise ValueError('invalid tolerance')
    segments=list(segments); wells=list(wells); utilities=list(utilities)
    base=legacy_analyze(segments,wells,utilities,tolerance,cell_size)
    idx=SegmentGrid(segments,cell_size)
    ids={id(s):i for i,s in enumerate(segments)}
    parent=list(range(len(segments)))
    def root(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]]; i=parent[i]
        return i
    def union(i,j):
        a,b=root(i),root(j)
        if a!=b:parent[b]=a
    # Endpoints touching any other segment create topological connections (including T junctions).
    for i,s in enumerate(segments):
        for p in (s.a,s.b):
            for t in idx.candidates(p,p,tolerance):
                j=ids[id(t)]
                if i!=j and _point_to_segment(p,t)<=tolerance:union(i,j)
    well_connections={}
    for w in wells:
        attached=sorted({ids[id(s)] for s in idx.candidates(w.point,w.point,tolerance) if _point_to_segment(w.point,s)<=tolerance})
        well_connections[w.handle]=[segments[i].handle for i in attached]
        if junction_policy=='endpoints_and_wells' and len(attached)>1:
            for i in attached[1:]:union(attached[0],i)
    findings=[f for f in base['findings'] if f['code']!='DISCONNECTED_COMPONENT']
    # A midspan-to-midspan geometric crossing is ambiguous: do not merge network components.
    seen=set()
    for i,s in enumerate(segments):
        for t in idx.candidates(s.a,s.b):
            j=ids[id(t)]
            if j<=i:continue
            p=_intersection(s,t)
            if p is None:continue
            if min(dist(p,s.a),dist(p,s.b),dist(p,t.a),dist(p,t.b))<=tolerance:continue
            key=(s.handle,t.handle)
            if key not in seen:
                seen.add(key)
                findings.append(dict(code='AMBIGUOUS_NETWORK_CROSSING',priority='medium',handles=list(key),point=list(p),message='Interior 2D crossing; connectivity and elevation unverified',certainty='candidate_issue'))
    components=defaultdict(list)
    for i,s in enumerate(segments):components[root(i)].append(s.handle)
    ordered=sorted((sorted(c) for c in components.values()),key=lambda c:(c[0],len(c)))
    for c in ordered[1:]:
        first=next(s for s in segments if s.handle==c[0])
        findings.append(dict(code='DISCONNECTED_COMPONENT',priority='medium',handles=c,point=list(first.a),message='Separate 2D network component',certainty='candidate_issue'))
    findings.sort(key=lambda f:(f['code'],tuple(f['handles']),tuple(f['point'])))
    return {'schema_version':'0.24','units':'drawing_units','coordinate_system':'unverified',
            'tolerance':tolerance,'cell_size':cell_size,'junction_policy':junction_policy,
            'summary':{'segments':len(segments),'wells':len(wells),'utilities':len(utilities),'components':len(ordered),'findings':len(findings)},
            'components':[{'handles':c,'segment_count':len(c)} for c in ordered],
            'well_connections':well_connections,'findings':findings}
