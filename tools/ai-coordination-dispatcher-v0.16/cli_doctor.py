"""Read-only Codex CLI diagnostics. This program never invokes a model.

Only `codex --version` and `codex login status` are executed. Authentication
files are never opened; subprocess text and diagnostic log text are never
returned. A cached login status does not establish remote model access.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


PROBE_FILES = ("codex-probe.stderr", "codex-probe.jsonl")


def inspect_probe_logs(directory):
    """Summarize known probes without exposing their contents or URLs."""
    report = {"available": False, "proxy_connect_403": False,
              "read_only_runtime": False, "remote_unauthorized": False,
              "model_response_observed": False, "newest_mtime": None}
    if directory is None:
        return report
    for name in PROBE_FILES:
        path = Path(directory) / name
        try:
            # Only read the two explicitly named logs. No auth/credential files.
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                text = handle.read(1_000_000)
            mtime = path.stat().st_mtime
        except OSError:
            continue
        report["available"] = True
        report["newest_mtime"] = max(report["newest_mtime"] or mtime, mtime)
        report["proxy_connect_403"] |= bool(re.search(
            r"HTTP CONNECT(?: failed)?[^\r\n]{0,100}\b403\b", text, re.I))
        report["read_only_runtime"] |= "read-only file system" in text.lower()
        # A CONNECT 403 is a transport failure, not evidence of an expired login.
        report["remote_unauthorized"] |= bool(re.search(
            r"\b(?:HTTP(?: status)?[ :]+401|unauthorized)\b", text, re.I))
        if name.endswith(".jsonl"):
            for line in text.splitlines():
                try:
                    event = json.loads(line)
                except (ValueError, TypeError):
                    continue
                item = event.get("item") if isinstance(event, dict) else None
                if isinstance(item, dict) and item.get("type") == "agent_message" and item.get("text"):
                    report["model_response_observed"] = True
    return report


def inspect_policy(path):
    """Read a non-secret startup snapshot; do not claim current enforcement."""
    result = {"available": False, "supported_version": False,
              "snapshot_only": True, "runtime_enforcement_verified": False}
    if path is None:
        return result
    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            data = json.loads(handle.read(1_000_000))
    except (OSError, ValueError, TypeError):
        return result
    if not isinstance(data, dict):
        return result
    result["available"] = True
    result["supported_version"] = data.get("version") == 1
    if not result["supported_version"]:
        return result
    policy = data.get("http_network_policy")
    if not isinstance(policy, dict):
        return result
    rules = policy.get("egress_rules", [])
    hosts = {r.get("host") for r in rules if isinstance(r, dict)} if isinstance(rules, list) else set()
    result.update(mode=policy.get("type") if policy.get("type") in ("restricted", "unrestricted", "disabled") else "unknown",
                  chatgpt_domain_listed="chatgpt.com" in hosts,
                  openai_api_domain_listed="api.openai.com" in hosts)
    return result


def _command(runner, executable, args):
    try:
        completed = runner([executable, *args], capture_output=True,
                           text=True, timeout=10, check=False)
        return "finished", completed.returncode, (completed.stdout or "") + "\n" + (completed.stderr or "")
    except subprocess.TimeoutExpired:
        return "timeout", None, ""
    except OSError:
        return "unavailable", None, ""


def collect(*, runner=subprocess.run, which=shutil.which, env=None,
            probe_directory=None, policy_path=None, default_home=None):
    env = os.environ if env is None else env
    home = Path.home() if default_home is None else Path(default_home)
    codex_root = Path(env.get("CODEX_HOME", str(home / ".codex")))
    executable = which("codex")
    version = None
    auth = {"command_status": "not_run", "return_code": None,
            "kind": "none", "local_login_present": False,
            "remote_credentials_verified": False}
    version_status = "not_run"
    if executable:
        version_status, version_rc, output = _command(runner, executable, ["--version"])
        match = re.search(r"(?m)^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)\s*$", output)
        if version_rc == 0 and match:
            version = match.group(1)
        state, code, output = _command(runner, executable, ["login", "status"])
        auth.update(command_status=state, return_code=code)
        if state == "finished" and code == 0:
            auth["local_login_present"] = True
            if re.search(r"\bChatGPT\b", output, re.I):
                auth["kind"] = "chatgpt"
            elif re.search(r"\bAPI[ -]?key\b", output, re.I):
                auth["kind"] = "api_key"
            else:
                auth["kind"] = "unknown"
    logs = inspect_probe_logs(probe_directory)
    blockers = []
    if not executable:
        blockers.append("cli_not_found")
    elif version is None:
        blockers.append("cli_version_unverified")
    if not auth["local_login_present"]:
        blockers.append("local_login_not_confirmed")
    elif auth["kind"] != "chatgpt":
        blockers.append("subscription_auth_not_confirmed_paid_api_forbidden")
    if "CODEX_DISABLED" in env:
        blockers.append("codex_disabled_gate_present")
    if logs["proxy_connect_403"]:
        blockers.append("previous_probe_proxy_connect_403")
    if logs["read_only_runtime"]:
        blockers.append("previous_probe_runtime_filesystem_read_only")
    if logs["remote_unauthorized"]:
        blockers.append("previous_probe_remote_unauthorized")
    return {
        "schema": "a2a-cli-doctor/v1", "read_only": True,
        "model_invoked": False, "paid_api_allowed": False,
        "cli": {"available": bool(executable), "version": version,
                "version_command_status": version_status},
        "auth": auth,
        "configuration": {"user_config_present": (codex_root / "config.toml").is_file(),
                          "codex_home_modified": False, "home_modified": False},
        "last_probe": logs, "network_snapshot": inspect_policy(policy_path),
        "blockers": blockers, "model_access_verified": False,
        "retry_without_meaningful_change": False,
        "next_step": (
            "After a meaningful verified policy/runtime change, retry one bounded read-only text probe with existing authorization."
            if logs["proxy_connect_403"] else
            "Inspect listed local blockers. A cached login or startup policy snapshot alone cannot validate model access."
        ),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe-directory", type=Path, default=Path("/workspace/a2a-runtime"))
    parser.add_argument("--policy-path", type=Path, default=Path("/etc/codex/network-policy.json"))
    args = parser.parse_args(argv)
    report = collect(probe_directory=args.probe_directory, policy_path=args.policy_path)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 2 if report["blockers"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
