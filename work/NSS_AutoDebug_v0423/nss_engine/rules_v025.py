"""v0.25: conservative, user-configured planar clearance screening.
No embedded Kazakhstan normative thresholds. All distances are drawing units.
"""
from dataclasses import dataclass
from math import dist, isfinite
from .analyzer import _intersection, _point_to_segment
from .spatial import SegmentGrid

@dataclass(frozen=True)
class ClearanceRule:
    utility_layer: str
    minimum_plan_distance: float
    source: str
    rule_id: str

    def __post_init__(self):
        if not self.utility_layer or not self.rule_id or not self.source:
            raise ValueError('layer, source and rule_id are required')
        if not isfinite(self.minimum_plan_distance) or self.minimum_plan_distance < 0:
            raise ValueError('minimum_plan_distance must be finite and nonnegative')

def segment_distance(a,b):
    if _intersection(a,b) is not None: return 0.0
    return min(_point_to_segment(a.a,b),_point_to_segment(a.b,b),
               _point_to_segment(b.a,a),_point_to_segment(b.b,a))

def evaluate(segments, utilities, rules, cell_size=10.0):
    segments=list(segments); utilities=list(utilities); rules=list(rules)
    if not isfinite(cell_size) or cell_size <= 0: raise ValueError('invalid cell size')
    for s in segments+utilities:
        if any(not isfinite(v) for p in (s.a,s.b) for v in p):
            raise ValueError('nonfinite geometry')
    if len({r.rule_id for r in rules}) != len(rules):
        raise ValueError('duplicate rule_id')
    index=SegmentGrid(segments,cell_size)
    findings=[]; evaluated=0; unmatched=set()
    by_layer={}
    for r in rules: by_layer.setdefault(r.utility_layer,[]).append(r)
    for u in utilities:
        active=by_layer.get(u.layer,[])
        if not active:
            unmatched.add(u.layer)
            continue
        for rule in active:
            for s in index.candidates(u.a,u.b,rule.minimum_plan_distance):
                evaluated+=1
                d=segment_distance(s,u)
                if d+1e-9 < rule.minimum_plan_distance:
                    findings.append({'code':'PLAN_CLEARANCE_REVIEW','priority':'medium',
                        'handles':[s.handle,u.handle],'point':list(s.a),
                        'measured_plan_distance':round(d,6),
                        'configured_minimum':rule.minimum_plan_distance,
                        'rule_id':rule.rule_id,'source':rule.source,
                        'certainty':'candidate_issue',
                        'message':'2D proximity below configured threshold; verify units, geometry, elevations and rule applicability'})
    findings.sort(key=lambda f:(f['rule_id'],*f['handles']))
    return {'findings':findings,'evaluated_pairs':evaluated,
            'unmatched_utility_layers':sorted(unmatched),
            'rules_loaded':len(rules),'normative_compliance_verified':False}
