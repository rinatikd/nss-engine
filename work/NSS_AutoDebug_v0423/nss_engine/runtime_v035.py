"""Offline runtime log analysis for NSS AutoCAD command logs."""
import argparse
import json
from collections import Counter
from pathlib import Path

MAX_LOG_BYTES = 20_000_000
ALLOWED = {"command_start", "command_end", "exception", "warning", "info"}

def analyze_events(events):
    if not isinstance(events, list):
        raise ValueError("events must be an array")
    issues, starts, counts = [], {}, Counter()
    for idx, event in enumerate(events):
        if not isinstance(event, dict) or event.get("event") not in ALLOWED:
            issues.append({"code":"INVALID_EVENT", "index":idx}); continue
        kind = event["event"]
        counts[kind] += 1
        command = event.get("command")
        run_id = event.get("run_id")
        if kind in ("command_start", "command_end") and (not isinstance(command,str) or not isinstance(run_id,str) or not run_id):
            issues.append({"code":"MISSING_COMMAND_ID", "index":idx}); continue
        if kind == "command_start":
            if run_id in starts:
                issues.append({"code":"DUPLICATE_START", "run_id":run_id})
            starts[run_id] = command
        elif kind == "command_end":
            if run_id not in starts:
                issues.append({"code":"UNMATCHED_END", "run_id":run_id})
            elif starts.pop(run_id) != command:
                issues.append({"code":"COMMAND_MISMATCH", "run_id":run_id})
        elif kind == "exception":
            issues.append({"code":"RUNTIME_EXCEPTION", "command":command, "exception_type":event.get("exception_type", "unknown")})
    for run_id, command in starts.items():
        issues.append({"code":"INCOMPLETE_COMMAND", "run_id":run_id, "command":command})
    return {"schema_version":"0.35", "event_count":len(events), "counts":dict(counts), "issues":issues, "healthy":not issues}

def analyze_file(source, output):
    source = Path(source)
    if source.stat().st_size > MAX_LOG_BYTES:
        raise ValueError("Log too large")
    events = []
    with source.open(encoding="utf-8-sig") as f:
        for line in f:
            if line.strip():
                events.append(json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite number"))))
    report = analyze_events(events)
    target = Path(output)
    target.parent.mkdir(parents=True,exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    temp.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    temp.replace(target)
    return report

if __name__ == "__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--log",required=True); p.add_argument("--output",required=True)
    args=p.parse_args()
    print(json.dumps(analyze_file(args.log,args.output),ensure_ascii=False,indent=2))
