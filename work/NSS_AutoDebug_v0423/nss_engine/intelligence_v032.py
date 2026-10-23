"""Conservative DWG snapshot classification and obstacle extraction (v0.32)."""
from __future__ import annotations
import json
import math
from pathlib import Path

CATEGORIES = ('network', 'water', 'sewer', 'gas', 'power', 'heat', 'telecom', 'unknown')

def classify_layer(layer: str, mapping: dict[str, str]) -> str:
    """Explicit case-insensitive exact layer mapping; no unsafe name guesses."""
    if not isinstance(layer, str):
        return 'unknown'
    normalized = layer.strip().casefold()
    for name, category in mapping.items():
        if isinstance(name, str) and name.strip().casefold() == normalized:
            if category not in CATEGORIES:
                raise ValueError('unsupported category: ' + str(category))
            return category
    return 'unknown'

def _point(p):
    if not isinstance(p, dict) or any(k not in p for k in ('x', 'y')):
        raise ValueError('point requires x and y')
    x, y = p['x'], p['y']
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (x,y)):
        raise ValueError('nonfinite or invalid coordinates')
    return float(x), float(y)

def analyze_snapshot(snapshot: dict, mapping: dict[str,str], clearance: float = 0.0) -> dict:
    if not isinstance(snapshot, dict) or not isinstance(mapping, dict):
        raise ValueError('snapshot and mapping must be objects')
    if isinstance(clearance, bool) or not isinstance(clearance, (int,float)) or not math.isfinite(clearance) or clearance < 0:
        raise ValueError('clearance must be finite and nonnegative')
    items, obstacles, warnings = [], [], list(snapshot.get('warnings', []))
    for source in ('segments', 'utilities'):
        entries = snapshot.get(source, [])
        if not isinstance(entries, list):
            raise ValueError(source + ' must be an array')
        for index, item in enumerate(entries):
            try:
                if not isinstance(item, dict):
                    raise ValueError('entry must be an object')
                a, b = _point(item.get('a')), _point(item.get('b'))
                category = classify_layer(item.get('layer', ''), mapping)
                if a == b:
                    warnings.append(f'{source}[{index}]: zero length')
                if category == 'unknown':
                    warnings.append(f'{source}[{index}]: layer not classified')
                record = {'source':source, 'handle':str(item.get('handle','')), 'layer':item.get('layer',''), 'category':category, 'a':list(a), 'b':list(b)}
                items.append(record)
                if source == 'utilities' and category not in ('unknown','network'):
                    obstacles.append({'handle':record['handle'], 'category':category, 'bbox':[min(a[0],b[0])-clearance,min(a[1],b[1])-clearance,max(a[0],b[0])+clearance,max(a[1],b[1])+clearance]})
            except (TypeError, ValueError) as ex:
                warnings.append(f'{source}[{index}]: invalid geometry: {ex}')
    return {'schema_version':'0.32', 'drawing_units':snapshot.get('drawing_units','unverified'), 'features':items, 'obstacle_candidates':obstacles, 'warnings':warnings, 'status':'review_required'}

def main(argv=None):
    import argparse
    p=argparse.ArgumentParser(description='Conservative layer classification of NSS snapshot')
    p.add_argument('--snapshot',required=True)
    p.add_argument('--mapping',required=True)
    p.add_argument('--output',required=True)
    p.add_argument('--clearance',type=float,default=0.0)
    args=p.parse_args(argv)
    snapshot=json.loads(Path(args.snapshot).read_text(encoding='utf-8'))
    mapping=json.loads(Path(args.mapping).read_text(encoding='utf-8'))
    result=analyze_snapshot(snapshot,mapping,args.clearance)
    Path(args.output).write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding='utf-8')
    print(f"features={len(result['features'])}, candidates={len(result['obstacle_candidates'])}, warnings={len(result['warnings'])}")

if __name__ == '__main__':
    main()
