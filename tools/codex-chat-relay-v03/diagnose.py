"""Read-only diagnostics for an explicitly allowlisted staging CODEX_HOME."""
from __future__ import annotations
import argparse, hashlib, json, os, shutil, subprocess, sys
from pathlib import Path

ALLOWED_PROFILE = {"approval_policy", "sandbox_mode", "features.shell_tool", "features.apps"}
EXPECTED = {"approval_policy": "on-request", "sandbox_mode": "read-only", "features.shell_tool": False, "features.apps": False}

def profile_findings(path: Path) -> list[str]:
    import tomllib
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return ["profile missing, unreadable, or malformed"]
    if set(data) - {"approval_policy", "sandbox_mode", "features"}:
        return ["profile contains a source outside the reviewed allowlist"]
    flattened = {"approval_policy": data.get("approval_policy"), "sandbox_mode": data.get("sandbox_mode")}
    features = data.get("features") if isinstance(data.get("features"), dict) else {}
    if set(features) - {"shell_tool", "apps"}:
        return ["profile contains an unreviewed feature source"]
    flattened.update({f"features.{key}": value for key, value in features.items()})
    findings = []
    if set(flattened) != ALLOWED_PROFILE:
        findings.append("profile keys differ from reviewed allowlist")
    if flattened != EXPECTED:
        findings.append("profile values differ from reviewed allowlist")
    return findings

def sanitized_report(executable: Path, version: str, digest: str, features: str, mcp: str) -> dict:
    # Never serialize raw tool names, endpoints, environment variables, or paths.
    feature_lines = [line for line in features.splitlines() if line.strip()]
    mcp_lines = [line for line in mcp.splitlines() if line.strip()]
    return {
        "diagnostic_only": True,
        "model_invoked": False,
        "tools_invoked": False,
        "executable_present": executable.is_file(),
        "executable_sha256": digest,
        "version_matches_reviewed_pin": version.strip() == "codex-cli 0.164.0",
        "effective_feature_rows_observed": len(feature_lines),
        "effective_mcp_rows_observed": len(mcp_lines),
        "effective_tools": "UNVERIFIED: CLI listings do not prove built-in, managed, inherited, extension, or host policy isolation",
        "managed_policy": "UNVERIFIED",
        "windows_sandbox": "UNVERIFIED",
    }

def run(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-only", action="store_true")
    ap.add_argument("--profile", type=Path, default=Path(__file__).parent / "staging-profile" / "config.toml")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args(argv)
    findings = profile_findings(args.profile)
    if args.source_only:
        print(json.dumps({"diagnostic_only": True, "profile_allowlist_valid": not findings, "findings": findings, "launch_authorized": False}, indent=2))
        return 0 if not findings else 2
    exe = shutil.which("codex")
    if not exe:
        print("BLOCKED: Codex executable not found; no launch attempted.")
        return 3
    path = Path(exe).resolve(strict=True)
    env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "TEMP", "TMP") if key in os.environ}
    # The temporary allowlist CODEX_HOME is only for read-only introspection; never a launch permit.
    env["CODEX_HOME"] = str(Path(__file__).parent / "staging-profile")
    try:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        version = subprocess.run([str(path), "--version"], env=env, capture_output=True, text=True, timeout=10, check=True, shell=False).stdout
        features = subprocess.run([str(path), "features", "list"], env=env, capture_output=True, text=True, timeout=15, check=True, shell=False).stdout
        mcp = subprocess.run([str(path), "mcp", "list"], env=env, capture_output=True, text=True, timeout=15, check=True, shell=False).stdout
    except Exception:
        print("BLOCKED: read-only CLI diagnostics failed; details withheld.")
        return 3
    report = sanitized_report(path, version, digest, features, mcp)
    report["profile_allowlist_valid"] = not findings
    report["launch_authorized"] = False
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(run())
