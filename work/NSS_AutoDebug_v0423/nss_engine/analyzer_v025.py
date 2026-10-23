"""Combine v0.24 topology with configurable planar engineering checks."""
from .analyzer_v024 import analyze as topology_analyze
from .rules_v025 import evaluate

def analyze(segments, wells=(), utilities=(), rules=(), tolerance=0.05, cell_size=10.0,
            junction_policy='endpoints_and_wells'):
    segments=list(segments); wells=list(wells); utilities=list(utilities)
    report=topology_analyze(segments,wells,utilities,tolerance,cell_size,junction_policy)
    checks=evaluate(segments,utilities,rules,cell_size)
    report['schema_version']='0.25'
    report['findings'].extend(checks.pop('findings'))
    report['findings'].sort(key=lambda f:(f['code'],tuple(f['handles'])))
    report['summary']['findings']=len(report['findings'])
    report['engineering_rules']=checks
    return report
