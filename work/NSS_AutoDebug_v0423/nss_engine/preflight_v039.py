"""Read-only preflight of NSS v0.31 route previews before AutoCAD import."""
import argparse
import json
import math
from pathlib import Path

MAX_BYTES = 8_000_000
MAX_POINTS = 20_000

def check_preview(data, drawing=None):
    errors, warnings = [], []
    if not isinstance(data, dict):
        return {"ok": False, "errors": ["root_not_object"], "warnings": []}
    for key, expected in (("schema_version", "0.31"), ("kind", "route_preview"),
                          ("units", "unverified_raw_drawing_units")):
        if data.get(key) != expected: errors.append("invalid_" + key)
    if data.get("requires_engineer_approval") is not True: errors.append("approval_flag_missing")
    source = data.get("source_drawing")
    if drawing and source and Path(str(source).replace("\\", "/")).name.lower() != Path(drawing.replace("\\", "/")).name.lower():
        errors.append("drawing_mismatch")
    routes = data.get("routes")
    if not isinstance(routes, list) or not 1 <= len(routes) <= 20:
        errors.append("invalid_route_count")
        routes = []
    seen = set(); total_points=0
    for idx, route in enumerate(routes):
        prefix = f"route_{idx}:"
        if not isinstance(route, dict): errors.append(prefix + "not_object"); continue
        rid = route.get("id")
        if not isinstance(rid, str) or not 1 <= len(rid) <= 64 or not all(c.isalnum() or c == "_" for c in rid) or not rid.isascii():
            errors.append(prefix + "invalid_id")
        elif rid.lower() in seen: errors.append(prefix + "duplicate_id")
        else: seen.add(rid.lower())
        pts = route.get("points")
        if not isinstance(pts, list) or not 2 <= len(pts) <= MAX_POINTS:
            errors.append(prefix + "invalid_points"); continue
        total_points+=len(pts)
        if total_points>MAX_POINTS: errors.append("total_point_limit")
        normalized = []
        for point in pts:
            if (not isinstance(point, list) or len(point) != 2 or
                any(isinstance(x, bool) or not isinstance(x, (int, float)) or
                    abs(x) > 1e9 or not math.isfinite(x) for x in point)):
                errors.append(prefix + "invalid_coordinate"); break
            normalized.append(point)
        if len(normalized) == len(pts):
            if all(math.dist(a, b) < 1e-9 for a,b in zip(normalized, normalized[1:])):
                errors.append(prefix + "degenerate_route")
            if any(math.dist(a,b) < 1e-9 for a,b in zip(normalized,normalized[1:])):
                warnings.append(prefix + "repeated_adjacent_point")
    warnings.append("drawing_units_and_coordinate_system_require_engineer_confirmation")
    return {"ok": not errors, "errors": errors, "warnings": warnings, "route_count": len(routes)}

def check_file(path, drawing=None):
    path = Path(path)
    if not path.is_file(): return {"ok": False, "errors": ["file_missing"], "warnings": []}
    if path.stat().st_size > MAX_BYTES: return {"ok": False, "errors": ["file_too_large"], "warnings": []}
    try:
        with path.open(encoding="utf-8") as f: return check_preview(json.load(f), drawing)
    except (ValueError, UnicodeError, OSError) as exc:
        return {"ok": False, "errors": ["invalid_json_or_encoding", type(exc).__name__], "warnings": []}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", required=True)
    parser.add_argument("--drawing")
    parser.add_argument("--output")
    args = parser.parse_args()
    result = check_file(args.preview, args.drawing)
    output = json.dumps(result, indent=2, ensure_ascii=False)
    if args.output: Path(args.output).write_text(output + "\n", encoding="utf-8")
    print(output)
    return 0 if result["ok"] else 2

if __name__ == "__main__":
    raise SystemExit(main())
