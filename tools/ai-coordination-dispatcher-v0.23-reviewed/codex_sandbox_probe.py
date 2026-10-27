"""Fixed-command Windows sandbox probe. Never invokes a model; checks only write denial."""

from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

from codex_diagnostics import _minimal_environment, inspect_codex


def run_readonly_sandbox_probe(*, runner=subprocess.run, path_lookup=shutil.which,
                               preflight=inspect_codex, temp_base=None):
    """Run one echo and one expected-denied write using a fixed sandbox command."""
    if platform.system() != "Windows":
        return {"state": "BLOCKED", "reason": "Windows sandbox probe is available only on Windows.",
                "model_started": False, "codex_execution_ready": False}

    raw_path = path_lookup("codex")
    if not raw_path:
        return {"state": "BLOCKED", "reason": "Codex CLI executable was not found.",
                "model_started": False, "codex_execution_ready": False}
    binary = Path(raw_path)
    if not binary.is_absolute() or binary.suffix.lower() != ".exe" or binary.is_symlink() or not binary.is_file():
        return {"state": "BLOCKED", "reason": "Codex must resolve to a regular absolute executable.",
                "model_started": False, "codex_execution_ready": False}

    identity = preflight(runner=runner, path_lookup=lambda _: str(binary))
    if not identity.get("available") or not identity.get("publisher_verified"):
        return {"state": "BLOCKED", "reason": "Codex executable identity preflight did not pass.",
                "model_started": False, "codex_execution_ready": False}

    common = [str(binary), "-c", "windows.sandbox=unelevated", "sandbox",
              "--include-managed-config", "--permission-profile", ":read-only", "--",
              "cmd.exe", "/d", "/c"]
    env = _minimal_environment()
    try:
        echo = runner(common + ["echo CODEX_READONLY_SANDBOX_OK"], capture_output=True, text=True,
                      encoding="utf-8", errors="replace", timeout=30, check=False, env=env)
        echo_ok = echo.returncode == 0 and (echo.stdout or "").strip() == "CODEX_READONLY_SANDBOX_OK"
        if not echo_ok:
            return {"state": "BLOCKED", "implementation": "unelevated", "read_only_profile": ":read-only",
                    "echo_probe_passed": False, "write_probe_denied": False, "model_started": False,
                    "codex_execution_ready": False,
                    "reason": "The fixed sandbox echo probe did not return its expected result."}

        with tempfile.TemporaryDirectory(prefix="codex-readonly-probe-", dir=temp_base) as folder:
            marker = Path(folder) / "write-must-be-denied.tmp"
            command = f'echo CODEX_WRITE_PROBE_STARTED & echo CODEX_WRITE_MUST_FAIL > "{marker}"'
            write = runner(common + [command], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=30, check=False, env=env)
            marker_created = marker.exists()
            # An absent file and a nonzero exit also occur when the CLI crashes
            # before the command starts. Require evidence from this write phase,
            # not merely the earlier echo process. Unknown/localized diagnostics
            # stay inconclusive rather than becoming a false isolation PASS.
            write_started = (write.stdout or "").strip() == "CODEX_WRITE_PROBE_STARTED"
            denial_reported = (getattr(write, "stderr", "") or "").strip().casefold() == "access is denied."
            write_denied = write_started and denial_reported and write.returncode != 0 and not marker_created
            if marker_created:
                marker.unlink()

        passed = echo_ok and write_denied
        return {
            "state": "PASS_FIXED_WRITE_DENIAL_PROBE" if passed else "BLOCKED",
            "implementation": "unelevated",
            "read_only_profile": ":read-only",
            "echo_probe_passed": echo_ok,
            "write_probe_denied": write_denied,
            "write_probe_started": write_started,
            "write_denial_diagnostic_recognized": denial_reported,
            "model_started": False,
            "read_denial_enforced": False,
            "network_isolation_verified": False,
            "codex_execution_ready": False,
            "reason": (
                "This probe checks command startup and write denial only; it does not prove read or network isolation."
                if passed else
                "The write probe did not establish denial; startup failures and unrecognized diagnostics are inconclusive."
            ),
        }
    except (OSError, subprocess.SubprocessError):
        return {"state": "BLOCKED", "implementation": "unelevated", "read_only_profile": ":read-only",
                "echo_probe_passed": False, "write_probe_denied": False, "model_started": False,
                "codex_execution_ready": False,
                "reason": "The sandbox probe could not complete; no Codex model task was started."}
