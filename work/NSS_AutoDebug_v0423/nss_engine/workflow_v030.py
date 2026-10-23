"""Read-only, deterministic integration workflow for legacy AutoCAD snapshots."""
import json, math
from pathlib import Path
from dataclasses import asdict
from .snapshot_v025 import analyze_snapshot
from .optimization_v028 import compare
from .routing_v027 import Rect
from .cost_v029 import ConstructionInputs, estimate

def _xy(point):
    if not isinstance(point,(list,tuple)) or len(point)!=2 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in point):
        raise ValueError('coordinates must be finite XY pairs')
    return tuple(float(v) for v in point)

def run(snapshot_path, plan_path, rules_path=None):
    """No changes to DWG. Coordinates are unverified raw drawing units."""
    with open(plan_path,encoding='utf-8') as stream: plan=json.load(stream)
    if plan.get('schema_version')!='0.30': raise ValueError('unsupported plan schema')
    start,goal=_xy(plan['start']),_xy(plan['goal'])
    obstacles=[Rect(**r) for r in plan.get('obstacles',[])]
    soft=[Rect(**r) for r in plan.get('soft_zones',[])]
    geometry=analyze_snapshot(snapshot_path,rules_path=rules_path)
    options=compare(start,goal,obstacles,soft,step=plan.get('step',1),margin=plan.get('margin',10))
    priced={}; rejected={}
    for name,result in options.items():
        if result['status']!='OK':
            rejected[name]=result['reason'] or result['status'];continue
        cfg=plan.get('construction',{}).get(name)
        if cfg is None:
            rejected[name]='no engineer-supplied construction parameters';continue
        priced[name]=estimate(result['points'],ConstructionInputs(**cfg))
    ranking=sorted(priced,key=lambda name:(priced[name]['total'],name))
    return {'schema_version':'0.30','status':'conceptual_review_only',
        'source_snapshot':str(snapshot_path),'source_plan':str(plan_path),
        'coordinate_units':'unverified_raw_drawing_units',
        'engineering_analysis':geometry,'routes':options,'estimates':priced,
        'unpriced_routes':rejected,'cost_ranking':ranking,
        'warnings':['Route and obstacles must be engineer-supplied; no automatic extraction of obstacle geometry from DWG.',
                    'Raw DWG units are not proven to be metres; lengths and cost estimates require unit verification.',
                    'No verified Kazakhstan normative rules are included by default.',
                    'Cost ranking is not design approval; human verification required.']}

def write_report(result,path):
    target=Path(path)
    if any(source and target.resolve()==Path(source).resolve() for source in (result.get('source_snapshot'),result.get('source_plan'))):
        raise ValueError('report must not overwrite source input')
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    return target
