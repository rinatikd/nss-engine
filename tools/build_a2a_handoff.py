"""Package the guarded text source tree for account transfer, without runtime state."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if output.is_relative_to(ROOT):
        raise ValueError('Build outside the source checkout')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT))
    if dirty:
        raise ValueError('Commit the guarded snapshot before packaging')
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    files = {}
    for name in filter(None, paths):
        path = ROOT / name
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
            raise ValueError('Unexpected source link')
        files['repository/' + name] = subprocess.check_output(['git', 'show', commit + ':' + name], cwd=ROOT)
    for name in ('HANDOFF_RU.md', 'SOURCE_INVENTORY.md', 'VALIDATION.md',
                 'CONTINUATION_PROMPT.txt', 'LATEST_TESTS.txt'):
        files[name] = files['repository/docs/handoff/' + name]
    files['BUILD_INFO.txt'] = ('repository=rinatikd/nss-engine\nbranch=agent/codex/a2a-interface-mcp-v016\n'
                               + 'commit=' + commit + '\nworking_tree=' + str(dirty).lower() + '\n').encode()
    manifest = ''.join(hashlib.sha256(data).hexdigest() + '  ' + name + '\n'
                       for name, data in sorted(files.items()))
    files['BUNDLE_SHA256SUMS.txt'] = manifest.encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 27, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compresslevel=9)
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError('Archive CRC mismatch')
        for line in manifest.splitlines():
            digest, name = line.split('  ', 1)
            if hashlib.sha256(archive.read(name)).hexdigest() != digest:
                raise ValueError('Archive manifest mismatch')
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + '.sha256').write_text(digest + '  ' + output.name + '\n')
    print('::notice title=A2A archive SHA256::' + digest)
    print('PASS:', len(files), 'files;', output.stat().st_size, 'bytes; SHA256', digest)


if __name__ == '__main__':
    main()
