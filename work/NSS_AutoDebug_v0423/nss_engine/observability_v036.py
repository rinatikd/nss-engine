"""Offline diagnostics bundle builder; no DWG modification."""
import argparse
import json
import zipfile
from pathlib import Path
from .runtime_v035 import analyze_file

MAX_BYTES = 20_000_000

def make_bundle(log_path, output_path):
    log = Path(log_path)
    if not log.is_file() or log.stat().st_size > MAX_BYTES:
        raise ValueError("Log missing or too large")
    output = Path(output_path)
    if output.resolve() == log.resolve():
        raise ValueError("Output must differ from input")
    # Validate and analyze without writing report beside user files.
    import tempfile
    with tempfile.TemporaryDirectory() as folder:
        report = analyze_file(log, Path(folder) / "report.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(output.suffix + ".tmp")
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("report.json", json.dumps(report, ensure_ascii=False, indent=2))
            archive.writestr("README.txt", "NSS diagnostics v0.36. Review log for sensitive paths before sharing.\n")
            archive.write(log, "runtime.jsonl")
        tmp.replace(output)
    finally:
        tmp.unlink(missing_ok=True)
    return report

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(json.dumps(make_bundle(args.log, args.output), ensure_ascii=False, indent=2))
