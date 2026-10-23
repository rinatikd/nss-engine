"""Offline end-to-end validation: exported snapshot -> analysis -> route preview.
No DWG writes. No claims of AutoCAD runtime validation.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
from .workflow_v030 import run
from .preview_v031 import preview_from_report

MAX_INPUT_BYTES = 12_000_000

def _load(path):
    p = Path(path)
    if not p.is_file() or p.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError(f"missing or oversized input: {p}")
    return json.loads(p.read_text(encoding="utf-8"), parse_constant=lambda x: (_ for _ in ()).throw(ValueError("nonfinite JSON")))

def _fingerprint(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def validate(snapshot, plan, *, source_drawing=None, rules=None):
    """Validate files, run existing analysis and create a preview without writing to DWG."""
    snapshot_data = _load(snapshot)
    plan_data = _load(plan)
    if not isinstance(snapshot_data, dict) or not isinstance(plan_data, dict):
        raise ValueError("snapshot and plan must be JSON objects")
    if rules is not None: _load(rules)
    report = run(str(snapshot), str(plan), str(rules) if rules else None)
    preview = preview_from_report(report, source_drawing=source_drawing)
    routes = preview["routes"]
    if not routes: raise ValueError("no previewable routes")
    if any(not all(math.isfinite(v) for point in route["points"] for v in point) for route in routes):
        raise ValueError("nonfinite route coordinates")
    manifest = {
        "schema_version": "0.37", "kind": "offline_validation", "status": "PREVIEW_READY_NOT_APPROVED",
        "snapshot_sha256": _fingerprint(snapshot), "plan_sha256": _fingerprint(plan),
        "rules_sha256": _fingerprint(rules) if rules else None,
        "route_count": len(routes), "route_ids": [r["id"] for r in routes],
        "warnings": ["AutoCAD DLL compilation and NETLOAD are NOT verified.",
                     "Coordinate system and drawing units require engineer verification.",
                     "Preview geometry must be reviewed before insertion into a DWG.",
                     "Obstacles in the plan are engineer supplied, not extracted automatically."],
    }
    return report, preview, manifest

def _write(path, data):
    p=Path(path); p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False),encoding="utf-8")

def main(argv=None):
    parser=argparse.ArgumentParser(description="NSS v0.37 offline end-to-end validation")
    parser.add_argument("--snapshot",required=True)
    parser.add_argument("--plan",required=True)
    parser.add_argument("--output-dir",required=True)
    parser.add_argument("--source-drawing")
    parser.add_argument("--rules")
    args=parser.parse_args(argv)
    report,preview,manifest=validate(args.snapshot,args.plan,source_drawing=args.source_drawing,rules=args.rules)
    out=Path(args.output_dir)
    _write(out/"report_v037.json",report)
    _write(out/"preview_v037.json",preview)
    _write(out/"validation_v037.json",manifest)
    print(f"OFFLINE PREVIEW READY: {manifest['route_count']} routes. NOT AutoCAD-validated. Files: {out}")

if __name__=="__main__": main()
