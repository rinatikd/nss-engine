"""Offline validation of AutoCAD v0.41 read-only inventory reports."""
import argparse
import json
from pathlib import Path

KINDS = ("lines", "polylines", "blocks", "other", "failed")

def validate(data):
    issues = []
    if not isinstance(data, dict) or data.get("schema_version") != "0.41":
        return {"valid": False, "issues": ["INVALID_SCHEMA"]}
    counts = data.get("counts")
    if not isinstance(counts, dict):
        return {"valid": False, "issues": ["INVALID_COUNTS"]}
    for key in KINDS:
        value = counts.get(key)
        if type(value) is not int or value < 0:
            issues.append("INVALID_COUNT_" + key.upper())
    if not isinstance(data.get("drawing_name"), str) or not data["drawing_name"].strip():
        issues.append("MISSING_DRAWING_NAME")
    known_units = {"Inches", "Feet", "Miles", "Millimeters", "Centimeters", "Meters", "Kilometers", "Microinches", "Mils", "Yards", "Angstroms", "Nanometers", "Microns", "Decimeters", "Decameters", "Hectometers", "Gigameters", "Astronomical", "LightYears", "Parsecs", "USSurveyFeet", "USSurveyInch", "USSurveyYard", "USSurveyMile"}
    if not isinstance(data.get("insunits"), str) or data["insunits"] not in known_units:
        issues.append("UNITS_UNCONFIRMED")
    if type(counts.get("failed")) is int and counts["failed"] > 0:
        issues.append("OBJECT_READ_FAILURES")
    return {"valid": not issues, "issues": issues,
            "object_count": sum(counts[k] for k in KINDS if type(counts.get(k)) is int and counts[k] >= 0)}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()
    result = validate(json.loads(Path(args.input).read_text(encoding="utf-8-sig")))
    Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))
    return 0 if result["valid"] else 2

if __name__ == "__main__":
    raise SystemExit(main())
