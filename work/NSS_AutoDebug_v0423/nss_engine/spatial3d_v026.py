"""3D screening: elevations are explicit, no inferred normative compliance.
Geometry is piecewise linear with linear interpolation of z along each segment.
"""
from dataclasses import dataclass
from math import hypot, isfinite
from .analyzer import _intersection
from .rules_v025 import segment_distance

@dataclass(frozen=True)
class Line3D:
    handle: str
    a: tuple
    b: tuple
    layer: str = ''
    def __post_init__(self):
        if len(self.a)!=3 or len(self.b)!=3 or not all(isfinite(float(x)) for x in self.a+self.b):
            raise ValueError('3D endpoints require finite x,y,z')
        if not self.handle: raise ValueError('handle required')

@dataclass(frozen=True)
class VerticalRule:
    rule_id: str
    minimum_vertical: float
    source: str
    def __post_init__(self):
        if not self.rule_id or not self.source or not isfinite(self.minimum_vertical) or self.minimum_vertical < 0:
            raise ValueError('invalid vertical rule')

def _z_at(s,p):
    dx=s.b[0]-s.a[0]; dy=s.b[1]-s.a[1]
    den=dx*dx+dy*dy
    if den==0: return None
    t=((p[0]-s.a[0])*dx+(p[1]-s.a[1])*dy)/den
    return s.a[2]+max(0,min(1,t))*(s.b[2]-s.a[2])

def evaluate_3d(network, utilities, rules=(), xy_tolerance=1e-7, units='m'):
    """At crossing, compare interpolated Z of line centre-lines (not outer pipe surfaces).
    Parallel/non-crossing 3D minimum clearance is not computed.
    """
    if units!='m': raise ValueError('3D evaluation requires verified metres')
    if not isfinite(xy_tolerance) or xy_tolerance<0: raise ValueError('invalid tolerance')
    rules=list(rules)
    if len({r.rule_id for r in rules})!=len(rules): raise ValueError('duplicate rule IDs')
    findings=[]; counts={'crossings':0,'parallel_or_nearby':0,'unknown_geometry':0}
    for n in network:
        for u in utilities:
            a=type('S',(),{'a':n.a[:2],'b':n.b[:2]})()
            b=type('S',(),{'a':u.a[:2],'b':u.b[:2]})()
            p=_intersection(a,b)
            if p is None:
                if segment_distance(a,b)<=xy_tolerance:
                    counts['parallel_or_nearby']+=1
                    findings.append({'code':'NEARBY_3D_REVIEW','handles':[n.handle,u.handle],
                      'certainty':'needs_engineering_review','message':'Plan proximity; 3D clearance not computed for non-crossing segments'})
                continue
            counts['crossings']+=1
            z1=_z_at(n,p); z2=_z_at(u,p)
            if z1 is None or z2 is None:
                counts['unknown_geometry']+=1
                findings.append({'code':'UNRESOLVED_3D_CROSSING','handles':[n.handle,u.handle],
                  'point_xy':list(p),'certainty':'insufficient_geometry'})
                continue
            gap=abs(z1-z2)
            for r in rules:
                findings.append({'code':'VERTICAL_CLEARANCE_REVIEW' if gap+1e-9<r.minimum_vertical else 'VERTICAL_CLEARANCE_SCREENED',
                  'handles':[n.handle,u.handle],'point_xyz_network':[p[0],p[1],z1],
                  'point_xyz_utility':[p[0],p[1],z2], 'vertical_centerline_separation_m':round(gap,6),
                  'configured_minimum_m':r.minimum_vertical,'rule_id':r.rule_id,'source':r.source,
                  'certainty':'screening_only','message':'Centreline distance only; verify outside diameters, elevations and rule applicability'})
    return {'schema_version':'0.26','findings':findings,'summary':counts,
      'normative_compliance_verified':False,'geometry_assumption':'linear Z interpolation; centreline only',
      'coordinate_units':'m'}
