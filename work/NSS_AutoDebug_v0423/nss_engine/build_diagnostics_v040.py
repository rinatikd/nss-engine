"""Offline build-log triage. Never asserts AutoCAD runtime success."""
import argparse
import json
import re
from pathlib import Path

PATTERNS = (
    ("CS_COMPILER", re.compile(r"\berror CS\d{4}\b", re.I), "Review C# compiler error and source location"),
    ("MSBUILD", re.compile(r"\berror MSB\d{4}\b", re.I), "Review MSBuild project configuration"),
    ("SDK_MISSING", re.compile(r"NETSDK\d+|SDK .*not found", re.I), "Install/verify .NET 8 SDK"),
    ("AUTOCAD_REFERENCE", re.compile(r"MSB3245|Could not resolve this reference|Ac(?:Core|Db)?Mgd\.dll.*(?:missing|not found)", re.I), "Verify AutoCAD 2026 installation and reference paths"),
    ("RESTORE", re.compile(r"\berror NU\d{4}\b", re.I), "Inspect NuGet restore and package availability"),
)

def analyze(text: str):
    issues=[]
    for line_no, line in enumerate(text.splitlines(), 1):
        for code, pattern, advice in PATTERNS:
            if pattern.search(line):
                issues.append({"line":line_no,"category":code,"message":line.strip()[:1000],"recommendation":advice})
                break
    return {"schema":"nss.build_diagnostics.v0.40","issues":issues,"issue_count":len(issues),"build_success_confirmed":False}

def main():
    p=argparse.ArgumentParser(description="Analyze an existing dotnet build log")
    p.add_argument('--log',required=True,type=Path)
    p.add_argument('--output',required=True,type=Path)
    args=p.parse_args()
    result=analyze(args.log.read_text(encoding='utf-8-sig',errors='replace'))
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f"Found {result['issue_count']} diagnostic lines")
if __name__=='__main__': main()
