"""Read-only validation of AutoCAD export snapshots; no normative conclusions."""
import argparse
import json
import math
from pathlib import Path

MAX_BYTES = 50_000_000
MAX_OBJECTS = 2_000_000

def validate_snapshot(data):
    issues = []
    if not isinstance(data, dict):
        return {"valid": False, "issues": [{"code": "ROOT_TYPE", "severity": "error"}]}
    version = data.get("schema_version")
    if version not in ("0.22", "0.33", "0.34"):
        issues.append({"code": "SCHEMA_VERSION", "severity": "error", "value": str(version)})
    metadata = data.get("metadata") or {}
    if not isinstance(metadata, dict):
        metadata = {}
        issues.append({"code": "METADATA_TYPE", "severity": "error"})
    if metadata.get("units") in (None, "unverified") or data.get("drawing_units") == "raw_drawing_units":
        issues.append({"code": "UNVERIFIED_UNITS", "severity": "warning"})
    if metadata.get("coordinate_system") in (None, "unverified"):
        issues.append({"code": "UNVERIFIED_CRS", "severity": "warning"})
    segments = data.get("segments", [])
    if not isinstance(segments, list) or len(segments) > MAX_OBJECTS:
        issues.append({"code": "SEGMENT_COLLECTION", "severity": "error"})
        segments = []
    seen = set()
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            issues.append({"code": "SEGMENT_TYPE", "severity": "error", "index": index}); continue
        handle = segment.get("handle")
        if not isinstance(handle, str) or not handle:
            issues.append({"code": "MISSING_HANDLE", "severity": "warning", "index": index})
        elif handle in seen:
            issues.append({"code": "DUPLICATE_HANDLE", "severity": "warning", "index": index, "handle": handle})
        if isinstance(handle,str): seen.add(handle)
        coords = []
        for key in ("a", "b"):
            point = segment.get(key)
            if not isinstance(point, dict) or any(not isinstance(point.get(k), (float, int)) or isinstance(point.get(k), bool) or not math.isfinite(point[k]) for k in ("x", "y")):
                issues.append({"code": "INVALID_POINT", "severity": "error", "index": index, "field": key}); break
            coords.append((point["x"], point["y"]))
        if len(coords) == 2 and coords[0] == coords[1]:
            issues.append({"code": "ZERO_LENGTH", "severity": "warning", "index": index})
    return {"valid": not any(i["severity"] == "error" for i in issues), "schema_version": version, "segment_count": len(segments), "issues": issues}

def run(snapshot, output):
    source = Path(snapshot)
    if source.resolve()==Path(output).resolve():raise ValueError('output must differ from input')
    if source.stat().st_size > MAX_BYTES:
        raise ValueError("Snapshot exceeds 50 MB limit")
    with source.open(encoding="utf-8") as f:
        data = json.load(f, parse_constant=lambda x: (_ for _ in ()).throw(ValueError("Non-finite JSON number")))
    report = validate_snapshot(data)
    destination = Path(output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(destination)
    return report

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = run(args.snapshot, args.output)
    print(json.dumps({"valid": result["valid"], "issues": len(result["issues"])}, ensure_ascii=False))
    raise SystemExit(0 if result["valid"] else 2)
