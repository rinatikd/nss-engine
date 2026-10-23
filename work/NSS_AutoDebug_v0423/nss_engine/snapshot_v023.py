import json
from .analyzer import Segment, Well
from .analyzer_v023 import analyze

def analyze_snapshot(path,tolerance=.05,cell_size=10.):
    with open(path,encoding='utf-8') as f: data=json.load(f)
    if data.get('schema_version') not in ('0.22','0.23'): raise ValueError('unsupported snapshot version')
    def pt(p):return (float(p['X']),float(p['Y']))
    def seg(s):return Segment(s['handle'],pt(s['a']),pt(s['b']),s.get('layer',''))
    def well(w):return Well(w['handle'],pt(w['point']))
    report=analyze([seg(s) for s in data['segments']],[well(w) for w in data['wells']],
                   [seg(s) for s in data['utilities']],tolerance,cell_size)
    report['source_warnings']=data.get('warnings',[])
    report['coordinate_system']='unverified'
    return report
