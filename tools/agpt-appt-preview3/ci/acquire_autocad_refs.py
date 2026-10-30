#!/usr/bin/env python3
"""Acquire pinned Autodesk compile references; never include them in a release.

Uses only Python's standard library and its default TLS/proxy configuration.
The cache contains original NuGet packages; output contains exactly three DLLs.
"""

from __future__ import annotations

import argparse
import hashlib
import io
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request
import zipfile


MAX_BYTES = 32 * 1024 * 1024
PACKAGES = (
    ("autocad.net", "AcMgd.dll"),
    ("autocad.net.core", "AcCoreMgd.dll"),
    ("autocad.net.model", "AcDbMgd.dll"),
)
SHA256 = {
    "25.0.0": (
        "856e483a5832ec65f7fffe6dca2700fd670299789da09981b529e1f4273ac146",
        "167a3b003d30230197cc150911080815bd5299e8e28fa411c64498e8e830ea53",
        "06779a73f5da2eed6a98c063ea13cde4eb07056b088772fca91c93ecdc770283",
    ),
    "25.1.0": (
        "8c3b799ff10e349dee37b504867c094839da9964d150da53eb4638af011f1662",
        "b9a016b7fad4de3e9f63835b16b4272b73909e26e0aa2565c91026c0af8afd9e",
        "fd52d86faa61ef91ccbf8fb8c3e327fc86f031e0d71da905fdf8b2e2acaee597",
    ),
}


def checked_bytes(stream, label: str, expected: str) -> bytes:
    data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError(f"{label}: exceeds the 32 MiB limit")
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"{label}: SHA256 mismatch; remove the bad cached package explicitly")
    return data


def acquire(version: str, cache: Path, output: Path) -> None:
    # Resolve for containment checks, but reject dangling output symlinks too.
    if output.exists() or output.is_symlink():
        raise ValueError(f"output already exists: {output}")
    output = output.resolve()
    cache = cache.resolve()
    if cache == output or output in cache.parents:
        raise ValueError("cache must not be inside the new output directory")
    if not output.parent.is_dir():
        raise ValueError(f"output parent directory must exist: {output.parent}")

    verified = {}
    # Reject any corrupt existing package before downloading or creating output.
    for (package, _), expected in zip(PACKAGES, SHA256[version]):
        filename = f"{package}.{version}.nupkg"
        path = cache / filename
        if path.exists() or path.is_symlink():
            with path.open("rb") as stream:
                verified[package] = checked_bytes(stream, filename, expected)

    for (package, _), expected in zip(PACKAGES, SHA256[version]):
        if package in verified:
            continue
        filename = f"{package}.{version}.nupkg"
        url = f"https://api.nuget.org/v3-flatcontainer/{package}/{version}/{filename}"
        with urllib.request.urlopen(url, timeout=60) as response:
            data = checked_bytes(response, filename, expected)
        cache.mkdir(parents=True, exist_ok=True)
        # A download is cached only after verification; partial downloads never
        # replace a package. Exclusive creation also prevents concurrent writes.
        try:
            with (cache / filename).open("xb") as stream:
                stream.write(data)
        except FileExistsError:
            with (cache / filename).open("rb") as stream:
                checked_bytes(stream, filename, expected)
        verified[package] = data

    # Stage only explicit member names, never extract archive-provided paths.
    # Verify all packages before even creating this temporary output directory.
    with tempfile.TemporaryDirectory(prefix=".autocad-refs-", dir=output.parent) as stage_name:
        stage = Path(stage_name)
        for package, dll in PACKAGES:
            member = f"lib/net8.0/{dll}"
            with zipfile.ZipFile(io.BytesIO(verified[package])) as archive:
                matches = [entry for entry in archive.infolist() if entry.filename == member]
                if len(matches) != 1 or matches[0].file_size > MAX_BYTES:
                    raise ValueError(f"{package}: missing, duplicate, or oversized {member}")
                with archive.open(matches[0]) as source, (stage / dll).open("xb") as target:
                    data = source.read(MAX_BYTES + 1)
                    if len(data) > MAX_BYTES:
                        raise ValueError(f"{package}: oversized {member}")
                    target.write(data)

        # mkdir is exclusive on Windows and Unix, including for empty existing
        # directories. Rename alone could overwrite an existing empty directory.
        output.mkdir()
        try:
            for _, dll in PACKAGES:
                with (stage / dll).open("rb") as source, (output / dll).open("xb") as target:
                    shutil.copyfileobj(source, target)
        except BaseException:
            shutil.rmtree(output)
            raise
    print(f"AutoCAD {version}: wrote three compile references to {output}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, choices=tuple(SHA256))
    parser.add_argument("--cache", required=True, type=Path, help="NuGet package cache directory")
    parser.add_argument("--output", required=True, type=Path, help="new reference directory (must not exist)")
    args = parser.parse_args()
    try:
        acquire(args.version, args.cache, args.output)
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
