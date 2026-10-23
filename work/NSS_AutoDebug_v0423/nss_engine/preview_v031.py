"""Strict, side-effect-free conversion of v0.30 report routes into v0.31 preview payload."""
import json, math
from pathlib import Path

MAX_ROUTES=20
MAX_POINTS=20000

def _point(p):
    if not isinstance(p,(list,tuple)) or len(p)!=2 or any(type(x) not in (int,float) or not math.isfinite(x) or abs(x)>1e9 for x in p):
        raise ValueError("invalid finite XY coordinate")
    return [float(p[0]),float(p[1])]

def preview_from_report(report, *, source_drawing=None):
    if not isinstance(report,dict) or report.get('schema_version')!='0.30':
        raise ValueError('expected v0.30 report')
    routes=report.get('routes')
    if not isinstance(routes,dict) or len(routes)>MAX_ROUTES:
        raise ValueError('invalid routes collection')
    result=[]; seen=set(); total=0
    for name, route in sorted(routes.items()):
        if not isinstance(name,str) or not (1<=len(name)<=64) or not name.isascii() or not all(c.isalnum() or c=='_' for c in name) or name.casefold() in seen or not isinstance(route,dict):
            raise ValueError('invalid route')
        seen.add(name.casefold())
        if route.get('status')!='OK': continue
        raw=route.get('points')
        if not isinstance(raw,list) or not 2<=len(raw)<=MAX_POINTS:
            raise ValueError('invalid route point count')
        total+=len(raw)
        if total>MAX_POINTS: raise ValueError('total point limit')
        pts=[_point(p) for p in raw]
        if all(a==b for a,b in zip(pts,pts[1:])): raise ValueError('degenerate route')
        result.append({'id':name,'points':pts})
    if not result: raise ValueError('no successful routes to preview')
    if source_drawing is not None and (not isinstance(source_drawing,str) or len(source_drawing)>260):
        raise ValueError('invalid drawing identifier')
    return {'schema_version':'0.31','kind':'route_preview','units':'unverified_raw_drawing_units',
            'source_drawing':source_drawing,'requires_engineer_approval':True,
            'routes':result}

def export_preview(report_path, output_path, *, source_drawing=None):
    if Path(report_path).resolve()==Path(output_path).resolve():raise ValueError('output must differ from report')
    report=json.loads(Path(report_path).read_text(encoding='utf-8'))
    payload=preview_from_report(report,source_drawing=source_drawing)
    Path(output_path).write_text(json.dumps(payload,indent=2,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    return payload
