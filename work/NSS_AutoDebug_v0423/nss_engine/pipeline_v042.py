"""XYZ -> recognition -> explicitly bounded XY screening. Does not alter a DWG."""
import argparse
from collections import Counter
import json
from pathlib import Path
from .contract_v042 import validate_snapshot
from .intelligence_v042 import recognize
from .analyzer import Segment
from .analyzer_v025 import analyze


def analyze_entities(entities, layer_mapping=None, *, max_segments=1000, features_limit=1000):
    if type(max_segments) is not int or not 1<=max_segments<=5000 or type(features_limit) is not int or not 0<=features_limit<=1000: raise ValueError('invalid screening limits')
    network,utilities,omitted,features=[],[],Counter(),[]
    unknown_layers=Counter()
    classifications=Counter();seen=set()
    for e in entities:
        if e['handle'].upper() in seen:
            raise ValueError('duplicate handle')
        seen.add(e['handle'].upper())
        r=recognize(e,layer_mapping);classifications[r['category']]+=1
        if len(features)<features_limit:
            features.append(dict(handle=e['handle'],layer=e['layer'],classification=r))
        if r['category']=='unknown':
            omitted['unknown_or_conflicting_classification']+=1;unknown_layers[e['layer']]+=1;continue
        if e['type']=='INSERT':
            omitted['insert_point_not_verified_physical_connection']+=1;continue
        if any(v[2]!=0 for v in e['vertices']):
            omitted['nonzero_z_not_projected']+=1;continue
        if any(e['bulges']):
            omitted['curved_geometry_not_chorded']+=1;continue
        pairs=list(zip(e['vertices'],e['vertices'][1:]))
        if e['closed']:pairs.append((e['vertices'][-1],e['vertices'][0]))
        if len(network)+len(utilities)+len(pairs)>max_segments:
            omitted['segment_budget']+=1;continue
        target=network if r['category']=='telecom' else utilities
        for i,(a,b) in enumerate(pairs):
            target.append(Segment(e['handle']+':'+str(i),tuple(a[:2]),tuple(b[:2]),e['layer']))
    report=analyze(network,utilities=utilities,junction_policy='endpoints_only')
    return dict(schema_version='0.42',status='ENGINEERING_REVIEW_REQUIRED',classifications=dict(classifications),
                unclassified_layers_to_review=dict(unknown_layers.most_common(20)),features_sample=features,features_truncated=len(seen)>len(features),
                omitted_from_xy_screening=dict(omitted),screening=report,
                physical_connectivity_confirmed=False,normative_compliance_verified=False,
                assumptions=['Only explicitly classified straight geometry at WCS Z=0 enters XY screening.',
                             'Arcs and nonzero Z are not silently flattened; insert points never establish connections.',
                             'Default layer vocabulary is a proposal and must be reviewed for the drawing.',
                             'Tolerances remain raw drawing units; no automatic conversion into construction dimensions.'])


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--snapshot',required=True,type=Path)
    p.add_argument('--mapping',type=Path)
    p.add_argument('--output',required=True,type=Path)
    args=p.parse_args()
    if args.output.exists() or args.snapshot.resolve()==args.output.resolve():p.error('output must be new')
    if args.snapshot.stat().st_size>256_000_000:p.error('input exceeds 256 MB')
    data=json.loads(args.snapshot.read_text(encoding='utf-8-sig'));validate_snapshot(data)
    mapping=json.loads(args.mapping.read_text(encoding='utf8')) if args.mapping else None
    report=analyze_entities(data['entities'],mapping);report['drawing']=data['drawing'];report['source_coverage']=data['coverage']
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf8')
    print(report['status'])


if __name__=='__main__':main()
