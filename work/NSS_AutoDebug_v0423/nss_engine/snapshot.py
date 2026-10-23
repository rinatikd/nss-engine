"""Read the AutoCAD export snapshot; never modify the source DWG."""
import json
from .analyzer import Segment, Well
from .analyzer_v022 import analyze

def analyze_snapshot(path, tolerance=0.05, cell_size=10.0):
    with open(path,encoding='utf-8') as f: data=json.load(f)
    if data.get('schema_version')!='0.22': raise ValueError('unsupported snapshot version')
    def pt(p): return (float(p['X']),float(p['Y']))
    def seg(s): return Segment(s['handle'],pt(s['a']),pt(s['b']),s.get('layer',''))
    def well(w): return Well(w['handle'],pt(w['point']))
    report=analyze(map(seg,data['segments']),map(well,data['wells']),map(seg,data['utilities']),tolerance,cell_size)
    report['source_warnings']=data.get('warnings',[])
    report['coordinate_system']='unverified'
    return report
