"""Assemble an allowlisted pilot candidate with optional explicitly supplied CAD resources."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = 'SOURCE_SHA256SUMS.txt'
SOURCE_ALLOWLIST = frozenset({
    '.gitattributes',
    'AGPT.csproj',
    'BUILD_AND_RUN.bat',
    'README_RU.md',
    'TEST_REPORT_RU.md',
    'blocks/README_SOURCE_ONLY.md',
    'build.bat',
    'build.ps1',
    'bundle/AGPT.bundle/PackageContents.xml',
    'ci/acquire_autocad_refs.py',
    'ci/package_candidate.py',
    'ci/test_package_blocks.py',
    'ci/test-resource-preflight.ps1',
    'ci/test-bundle-host.ps1',
    'core/AGPT.InputCore.csproj',
    'install_bundle.bat',
    'src/AGPT_Plugin_Drawings.cs',
    'src/AGPT_Stage3_Blocks_Full.cs',
    'src/AGPT_Stage4_Hydro_Axo_v2.cs',
    'src/APPT_Plugin_Drawings.cs',
    'src/AlbumOutput.cs',
    'src/CadPlanCapture.cs',
    'src/CadProjectSettings.cs',
    'src/Pagination.cs',
    'src/PluginData.cs',
    'src/PluginInit.cs',
    'src/ProjectCommands.cs',
    'src/GasZoneInput.cs',
    'src/GasZoneForm.cs',
    'src/RoomUnitInference.cs',
    'src/RoomTextFacts.cs',
    'src/RoomTemperaturePolicy.cs',
    'src/RoomGasPolicy.cs',
    'src/RoomOpeningsPolicy.cs',
    'src/RoomPresentationCommands.cs',
    'src/AlbumAxonometryRenderer.cs',
    'src/AlbumStructureRenderer.cs',
    'src/AlbumSpecificationRenderer.cs',
    'src/AxonometricProjection.cs',
    'src/SpecificationPageLayout.cs',
    'REFERENCE_LAYOUT_RU.md',
    'src/RoomPolygon.cs',
    'src/RoomBoundaryPicker.cs',
    'src/RoomModelFacts.cs',
    'src/RoomUnitEvidence.cs',
    'src/CadGasPipeVolumes.cs',
    'src/GasPipeDataCommands.cs',
    'src/ProjectGeometry.cs',
    'src/ProjectMetadata.cs',
    'src/ProjectPlanRenderer.cs',
    'src/ProjectSettingsCommands.cs',
    'src/TaggingPolicy.cs',
    'tests/AGPT.InputTests.csproj',
    'tests/BillOfMaterialsTests.cs',
    'tests/InputContractTests.cs',
    'tests/PaginationTests.cs',
    'tests/ProjectGeometryTests.cs',
    'tests/ProjectMetadataTests.cs',
    'tests/RequiredProjectInputTests.cs',
    'tests/TaggingPolicyTests.cs',
    'tests/GasZoneInputTests.cs',
    'tests/RoomUnitInferenceTests.cs',
    'tests/RoomTextFactsTests.cs',
    'tests/RoomTemperaturePolicyTests.cs',
    'tests/RoomGasPolicyTests.cs',
    'tests/RoomOpeningsPolicyTests.cs',
    'tests/AxonometricProjectionTests.cs',
    'tests/SpecificationPageLayoutTests.cs',
    'tests/ResourceLocatorTests.cs',
    'tests/RoomPolygonTests.cs',
})
BLOCK_ALLOWLIST = frozenset({
    'AGPT_Frame_A3.dwg', 'AGPT_Frame_A3.dxf', 'AGPT_UGO.dxf',
    'MMH_Stamp.dwg', 'MMX_ШТАМП.dwg', 'ММХ_Штамп.dwg',
    'Садик_UGO_source.dwg',
})
HOSTS = ('AutoCAD2025', 'AutoCAD2026')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def block_files(root):
    """Validate externally supplied assets; these never enter the source manifest."""
    if root is None:
        return {}
    root = Path(root).absolute()
    if any(p.is_symlink() for p in [root, *root.parents]) or not root.is_dir():
        raise ValueError('Missing or symlink blocks root')
    if {p.name for p in root.iterdir()} != BLOCK_ALLOWLIST:
        raise ValueError('Blocks root must contain exactly the reviewed CAD resource filenames')
    entries = {}
    for name in sorted(BLOCK_ALLOWLIST):
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Missing or symlink CAD resource: ' + name)
        data = path.read_bytes()
        if path.suffix.lower() == '.dwg':
            valid = re.match(rb'AC10[0-9]{2}', data) is not None
        else:
            valid = re.search(rb'(?:\A|\r?\n)[ \t]*0[ \t]*\r?\n[ \t]*EOF[ \t]*(?:\r?\n|\Z)', data) is not None
        if not valid:
            raise ValueError('Empty or invalid CAD resource header/EOF: ' + name)
        entries['blocks/' + name] = path
        for host in HOSTS:
            entries[f'Runtime/{host}/blocks/{name}'] = path
    return entries


def source_files():
    entries = {}
    for line in (ROOT / MANIFEST).read_text(encoding='utf-8').splitlines():
        checksum, name = line.split('  ', 1)
        parts = PurePosixPath(name)
        if (not re.fullmatch(r'[0-9a-f]{64}', checksum) or parts.is_absolute()
                or name not in SOURCE_ALLOWLIST or ':' in name or parts.as_posix() != name
                or '..' in parts.parts or '\\' in name or name in entries):
            raise ValueError('Invalid source manifest entry')
        path = ROOT / name
        if any(p.is_symlink() for p in [path, *path.parents]) or not path.is_file():
            raise ValueError('Missing or symlink source: ' + name)
        if path.suffix.lower() in {'.dll', '.exe', '.zip', '.dwg', '.dxf', '.nupkg'}:
            raise ValueError('Forbidden source file: ' + name)
        if digest(path) != checksum:
            raise ValueError('Source hash mismatch: ' + name)
        entries[name] = path
    if set(entries) != SOURCE_ALLOWLIST:
        raise ValueError('Source manifest must match the complete reviewed allowlist')
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-root', type=Path)
    parser.add_argument('--blocks-root', type=Path,
                        help='External folder containing the complete reviewed CAD resource set')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--commit')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    entries = source_files()
    resources = block_files(args.blocks_root)
    if args.verify_only:
        print(f'Verified {len(entries)} source hashes; {len(resources) // 3} CAD resources')
        return
    if not args.output or not args.runtime_root or not re.fullmatch(r'[0-9a-f]{40}', args.commit or ''):
        parser.error('Packaging requires --runtime-root, --output and a 40-hex --commit')
    output = args.output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError('Output must not exist')
    runtime = {}
    for host in HOSTS:
        for name in ('AGPT.dll', 'AGPT.InputCore.dll'):
            path = args.runtime_root / host / name
            if any(p.is_symlink() for p in [path, *path.parents]) or not path.is_file():
                raise ValueError('Missing or symlink runtime: ' + str(path))
            if path.stat().st_size == 0 or path.read_bytes()[:2] != b'MZ':
                raise ValueError('Not a compiled PE assembly: ' + str(path))
            runtime[f'Runtime/{host}/{name}'] = path
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='agpt-package-', dir=output.parent) as tmp:
        stage = Path(tmp) / 'candidate'
        stage.mkdir()
        for name, path in {**entries, MANIFEST: ROOT / MANIFEST, **runtime, **resources}.items():
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        (stage / 'RELEASE_INFO.json').write_text(json.dumps({
            'version': '1.1.0-preview.14', 'commit': args.commit,
            'nativeAutoCADVerified': False, 'engineeringAcceptanceVerified': False,
            'privateCadResourcesIncluded': bool(resources),
            'actualResourcesIncluded': bool(resources),
            'resourceNativeVerified': False,
            'resourceFileCount': len(resources) // (len(HOSTS) + 1),
            'resourceCopyCount': len(resources),
            'resourceSHA256': {name: digest(path) for name, path in resources.items()
                               if name.startswith('blocks/')},
            'status': 'pilot-candidate',
        }, indent=2) + '\n', encoding='utf-8')
        files = sorted(p for p in stage.rglob('*') if p.is_file())
        (stage / 'SHA256SUMS.txt').write_text(''.join(
            f'{digest(p)}  {p.relative_to(stage).as_posix()}\n' for p in files), encoding='utf-8')
        stage.rename(output)
    print(f'Packaged {len(files) + 1} files: {output}')


if __name__ == '__main__':
    main()
