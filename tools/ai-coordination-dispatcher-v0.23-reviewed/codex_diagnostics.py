"""Sanitized, read-only Codex CLI preflight; never starts a model session."""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess


VERSION = re.compile(r"^codex-cli\s+(\S+)\s*$", re.IGNORECASE)
MAX_VERSION_OUTPUT = 8192
EXPECTED_PUBLISHER = 'CN="OpenAI OpCo, LLC"'
EXPECTED_ORGANIZATION = 'O="OpenAI OpCo, LLC"'


def _minimal_environment(extra=None):
    allowed = ("SystemRoot", "WINDIR", "TEMP", "TMP")
    env = {key: os.environ[key] for key in allowed if os.environ.get(key)}
    if extra:
        env.update(extra)
    return env


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _authenticode(path, runner=subprocess.run):
    if platform.system() != "Windows":
        return {"status": "UNAVAILABLE", "publisher": None, "publisher_verified": False}

    powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if not powershell.is_file():
        return {"status": "UNAVAILABLE", "publisher": None, "publisher_verified": False}

    script = (
        "$s=Get-AuthenticodeSignature -LiteralPath $env:A2A_CODEX_DIAGNOSTIC_PATH; "
        "[pscustomobject]@{Status=$s.Status.ToString(); "
        "Subject=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null}} "
        "| ConvertTo-Json -Compress"
    )
    try:
        result = runner(
            [str(powershell), "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
            env=_minimal_environment({"A2A_CODEX_DIAGNOSTIC_PATH": str(path)}),
        )
        if result.returncode != 0 or len(result.stdout) > MAX_VERSION_OUTPUT:
            raise ValueError("signature command failed")
        parsed = json.loads(result.stdout)
        status = parsed.get("Status") if isinstance(parsed, dict) else None
        subject = parsed.get("Subject") if isinstance(parsed, dict) else None
        if not isinstance(status, str):
            raise ValueError("invalid signature result")
        publisher_verified = (
            status == "Valid"
            and isinstance(subject, str)
            and EXPECTED_PUBLISHER in subject
            and EXPECTED_ORGANIZATION in subject
        )
        return {
            "status": status,
            "publisher": "OpenAI OpCo, LLC" if publisher_verified else None,
            "publisher_verified": publisher_verified,
        }
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, json.JSONDecodeError):
        return {"status": "ERROR", "publisher": None, "publisher_verified": False}


def inspect_codex(*, runner=subprocess.run, path_lookup=shutil.which):
    """Report binary identity only; do not read config, auth, MCP, or launch a model."""
    raw_path = path_lookup("codex")
    if not raw_path:
        return {
            "available": False,
            "version": None,
            "sha256": None,
            "file_size": None,
            "signature_status": "NOT_FOUND",
            "publisher_verified": False,
            "codex_execution_ready": False,
            "reason": "Codex CLI executable was not found on PATH.",
        }

    path = Path(raw_path)
    if not path.is_absolute() or path.suffix.lower() not in (".exe", "") or path.is_symlink() or not path.is_file():
        return {
            "available": False,
            "version": None,
            "sha256": None,
            "file_size": None,
            "signature_status": "REJECTED_PATH",
            "publisher_verified": False,
            "codex_execution_ready": False,
            "reason": "Codex must resolve to a regular executable, not a script shim.",
        }

    try:
        size = path.stat().st_size
        checksum = _sha256(path)
    except OSError:
        return {
            "available": False,
            "version": None,
            "sha256": None,
            "file_size": None,
            "signature_status": "READ_ERROR",
            "publisher_verified": False,
            "codex_execution_ready": False,
            "reason": "Codex executable could not be inspected.",
        }

    signature = _authenticode(path, runner)
    if not signature["publisher_verified"]:
        return {
            "available": False,
            "version": None,
            "sha256": checksum,
            "file_size": size,
            "signature_status": signature["status"],
            "publisher_verified": False,
            "codex_execution_ready": False,
            "reason": "Version check skipped because the Windows Authenticode publisher is not verified.",
        }

    version = None
    try:
        result = runner(
            [str(path), "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
            check=False,
            env=_minimal_environment(),
        )
        output = (result.stdout or "").strip()
        if len(output) <= MAX_VERSION_OUTPUT and result.returncode == 0:
            match = VERSION.fullmatch(output)
            if match:
                version = match.group(1)
    except (OSError, subprocess.SubprocessError):
        pass

    return {
        "available": version is not None,
        "version": version,
        "sha256": checksum,
        "file_size": size,
        "signature_status": signature["status"],
        "publisher_verified": signature["publisher_verified"],
        "codex_execution_ready": False,
        "reason": "Preflight only: effective tools, auth context, and Windows sandbox isolation are not established.",
    }
