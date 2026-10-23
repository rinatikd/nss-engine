"""Offline preflight for AutoCAD C# adapter sources (not a compiler)."""
from pathlib import Path
import json, re

EXPECTED = {'NSS_EXPORT_V033', 'NSS_HEALTH_V034', 'NSS_DIAG_V036', 'NSS_SELFTEST_V035', 'NSS_PREVIEW_V031', 'NSS_CLEAR_PREVIEW_V031'}

def audit(project_root: Path) -> dict:
    root = Path(project_root)
    files = sorted((root / 'autocad').glob('*.cs'))
    commands = {}
    for path in files:
        for cmd in re.findall(r'\[CommandMethod\("([A-Za-z0-9_]+)"', path.read_text(encoding='utf-8-sig')):
            commands.setdefault(cmd, []).append(path.name)
    duplicates = {name: paths for name, paths in commands.items() if len(paths)>1}
    missing = sorted(EXPECTED - commands.keys())
    csproj = root / 'autocad' / 'NssEngine.Export.csproj'
    result = {'schema_version':'0.38','source_files':len(files),'commands':commands,
              'missing_commands':missing,'duplicate_commands':duplicates,
              'csproj_exists':csproj.is_file(),
              'requires_autocad_runtime_validation':True}
    result['passed'] = not missing and not duplicates and result['csproj_exists']
    return result

def main():
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument('--output', type=Path)
    a=p.parse_args()
    report=audit(a.root)
    data=json.dumps(report,indent=2,ensure_ascii=False)
    if a.output:
        a.output.parent.mkdir(parents=True,exist_ok=True)
        a.output.write_text(data + chr(10), encoding='utf-8')
    print(data)
    raise SystemExit(0 if report['passed'] else 1)
if __name__=='__main__': main()
