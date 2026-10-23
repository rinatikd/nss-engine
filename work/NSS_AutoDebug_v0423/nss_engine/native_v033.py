"""Normalize AutoCAD v0.33 exports for v0.32 intelligence without guessing network type."""
from __future__ import annotations
import json
from pathlib import Path
from .intelligence_v032 import analyze_snapshot

def normalize(snapshot, mapping):
    if not isinstance(snapshot, dict) or snapshot.get('schema_version') != '0.33':
        raise ValueError('expected v0.33 snapshot')
    if snapshot.get('drawing_units') != 'raw_drawing_units':
        raise ValueError('unexpected units: manual review required')
    records = snapshot.get('segments')
    if not isinstance(records, list):
        raise ValueError('segments must be an array')
    from .intelligence_v032 import classify_layer
    network, utilities = [], []
    for rec in records:
        if not isinstance(rec, dict):
            raise ValueError('segment must be an object')
        cat = classify_layer(rec.get('layer'), mapping)
        # Unknown layers remain in network input solely for reporting; not treated as obstacles.
        (utilities if cat not in ('network','telecom','unknown') else network).append(rec)
    output = analyze_snapshot({**snapshot, 'segments':network, 'utilities':utilities},mapping)
    output['schema_version'] = '0.33'
    output['source_drawing'] = snapshot.get('source_drawing','')
    output['warnings'].append('DWG units/coordinate system and classification must be verified by engineer')
    output['warnings'].append('Arc chords are approximations; geometry and Z not verified')
    return output

def main(argv=None):
    import argparse
    parser=argparse.ArgumentParser()
    parser.add_argument('--snapshot',required=True)
    parser.add_argument('--mapping',required=True)
    parser.add_argument('--output',required=True)
    args=parser.parse_args(argv)
    data=json.loads(Path(args.snapshot).read_text(encoding='utf-8'))
    mapping=json.loads(Path(args.mapping).read_text(encoding='utf-8'))
    result=normalize(data,mapping)
    Path(args.output).write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding='utf-8')
    print(f"features={len(result['features'])}, warnings={len(result['warnings'])}")
if __name__ == '__main__': main()
