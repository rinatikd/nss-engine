"""v0.22 indexed analyzer. Read-only; findings are hypotheses, not compliance verdicts."""
from math import dist, isfinite
from .analyzer import Segment, Well, _intersection, _point_to_segment, analyze as legacy_analyze
from .spatial import SegmentGrid

def analyze(segments, wells=(), utilities=(), tolerance=0.05, cell_size=10.0):
    if not isfinite(tolerance) or tolerance <= 0: raise ValueError('tolerance must be positive and finite')
    segments=list(segments); wells=list(wells); utilities=list(utilities)
    for s in segments+utilities:
        if any(not isfinite(v) for p in (s.a,s.b) for v in p): raise ValueError('coordinates must be finite')
    for w in wells:
        if any(not isfinite(v) for v in w.point): raise ValueError('coordinates must be finite')
    # Legacy endpoint diagnostics preserved; crossing/duplicate/well checks replaced with indexed passes.
    base=legacy_analyze(segments, [], [], tolerance, _endpoints_only=True)
    findings=[f for f in base['findings'] if f['code'] in ('ZERO_LENGTH','OPEN_END')]
    idx=SegmentGrid(segments,cell_size)
    object_ids={id(s):i for i,s in enumerate(segments)}
    for i,s in enumerate(segments):
        for t in idx.candidates(s.a,s.b,tolerance):
            j=object_ids[id(t)]
            if j<=i: continue
            if (dist(s.a,t.a)<=tolerance and dist(s.b,t.b)<=tolerance) or (dist(s.a,t.b)<=tolerance and dist(s.b,t.a)<=tolerance):
                findings.append(dict(code='DUPLICATE_SEGMENT',priority='high',handles=[s.handle,t.handle],point=list(s.a),message='Coincident segment geometry',certainty='geometric_fact'))
    for w in wells:
        if not any(_point_to_segment(w.point,s)<=tolerance for s in idx.candidates(w.point,w.point,tolerance)):
            findings.append(dict(code='UNCONNECTED_WELL',priority='medium',handles=[w.handle],point=list(w.point),message='Well is not on recognized network',certainty='candidate_issue'))
    for u in utilities:
        for s in idx.candidates(u.a,u.b):
            p=_intersection(s,u)
            if p is not None:
                findings.append(dict(code='UTILITY_CROSSING',priority='info',handles=[s.handle,u.handle],point=list(p),message='2D crossing; vertical clearance and norms not verified',certainty='geometric_fact'))
    findings.sort(key=lambda f:(f['code'],tuple(f['handles']),tuple(f['point'])))
    return {'schema_version':'0.22','units':'drawing_units','tolerance':tolerance,'cell_size':cell_size,
            'summary':{'segments':len(segments),'wells':len(wells),'utilities':len(utilities),'findings':len(findings)},'findings':findings}
