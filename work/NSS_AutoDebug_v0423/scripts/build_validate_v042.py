"""Reproducible offline verification. Never starts AutoCAD or changes its settings."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import uuid

root = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--autocad-dir', default=r'C:\Program Files\Autodesk\AutoCAD 2026')
    args = p.parse_args()
    output = root/'validation_v042'/uuid.uuid4().hex
    output.mkdir(parents=True)
    def run(name, command):
        with (output/name).open('wb') as stream:
            result = subprocess.run(command, cwd=root, stdout=stream, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(f'{name}: failed with code {result.returncode}')
    run('contract-tests.log', ['dotnet', 'run', '--project', 'contract_tests/ContractTests.csproj', '-p:NuGetAudit=false', '--', 'contract_fixture_v042.json'])
    run('python-tests.log', [sys.executable, '-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'tests', '-v'])
    for dll in ('AcCoreMgd.dll', 'AcDbMgd.dll', 'AcMgd.dll'):
        if not (Path(args.autocad_dir)/dll).is_file():
            raise FileNotFoundError('Missing Autodesk dependency: ' + dll)
    run('dotnet-build.log', ['dotnet', 'build', 'autocad/NssEngine.Export.csproj', '-c', 'Release', '-o', str(output/'plugin'), '-p:AutoCADDir='+args.autocad_dir, '-p:NuGetAudit=false', '--nologo'])
    (output/'status.json').write_text(json.dumps(dict(offline_checks='PASSED', autocad_runtime='NOT_TESTED', plugin=str(output/'plugin/NssEngine.Export.dll')), indent=2), encoding='utf8')
    print('Offline checks passed:', output)
    print('AutoCAD runtime remains untested.')


if __name__ == '__main__':
    main()
