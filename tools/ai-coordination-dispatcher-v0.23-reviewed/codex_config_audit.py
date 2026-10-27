"""Sanitized census of Codex config sources; this is not an effective-tools proof."""

import os
from pathlib import Path
import re


MAX_CONFIG_BYTES = 1024 * 1024
MAX_PROFILES = 25
MAX_PROJECT_ANCESTORS = 12
MCP_TABLE = re.compile(
    r'^\s*\[+\s*mcp_servers\.(?:"((?:[^"\\]|\\.)+)"|([A-Za-z0-9_-]+))(?=\s*(?:\.|\]))'
)
INLINE_MCP_TABLE = re.compile(r'^\s*mcp_servers\s*=')


def _read_config(path):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_CONFIG_BYTES:
            return None
        servers = set()
        inline = False
        with path.open("r", encoding="utf-8") as stream:
            for line in stream:
                if len(line) > 8192:
                    continue
                match = MCP_TABLE.match(line)
                if match:
                    servers.add(match.group(1) or match.group(2))
                elif INLINE_MCP_TABLE.match(line):
                    inline = True
        return {"mcp_server_table_count": len(servers), "inline_mcp_servers_detected": inline}
    except (OSError, UnicodeError):
        return None


def audit_codex_config(*, cwd=None, env=None, home=None):
    """Return only source categories/counts; never return paths, TOML values, or env values."""
    env = os.environ if env is None else env
    cwd = Path.cwd() if cwd is None else Path(cwd)
    home = Path.home() if home is None else Path(home)
    explicit_home = bool(env.get("CODEX_HOME"))
    codex_home = Path(env["CODEX_HOME"]) if explicit_home else home / ".codex"

    candidates = []
    base_config = codex_home / "config.toml"
    if base_config.exists():
        candidates.append(("user_base", base_config))

    profile_count = 0
    try:
        profiles = sorted(codex_home.glob("*.config.toml"))
    except OSError:
        profiles = []
    profile_count = min(len(profiles), MAX_PROFILES)
    candidates.extend(("user_profile", path) for path in profiles[:MAX_PROFILES])
    profile_overflow = len(profiles) > MAX_PROFILES

    project_paths = []
    current = cwd.resolve()
    project_directories = [current]
    found_repo_root = (current / ".git").exists()
    if not found_repo_root:
        for index, directory in enumerate(current.parents):
            if index >= MAX_PROJECT_ANCESTORS - 1:
                break
            project_directories.append(directory)
            if (directory / ".git").exists():
                found_repo_root = True
                break
    if not found_repo_root:
        project_directories = [current]
    for directory in project_directories:
        candidate = directory / ".codex" / "config.toml"
        if candidate.exists():
            project_paths.append(candidate)
    candidates.extend(("project", path) for path in project_paths)

    seen = set()
    counts = {"user_base": 0, "user_profile": 0, "project": 0}
    mcp_server_tables = 0
    inline_mcp_servers = False
    unreadable = 0
    for kind, path in candidates:
        key = os.path.normcase(str(path.absolute()))
        if key in seen:
            continue
        seen.add(key)
        census = _read_config(path)
        if census is None:
            unreadable += 1
            continue
        counts[kind] += 1
        mcp_server_tables += census["mcp_server_table_count"]
        inline_mcp_servers = inline_mcp_servers or census["inline_mcp_servers_detected"]

    known_env_names = (
        "CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID",
        "OPENAI_PROJECT_ID", "CODEX_API_KEY",
    )
    env_presence = {name: bool(env.get(name)) for name in known_env_names}
    return {
        "state": "PARTIAL_INVENTORY",
        "config_sources": {
            "explicit_codex_home": explicit_home,
        "user_base_configs_scanned": counts["user_base"],
            "user_profile_files_found": profile_count,
        "user_profile_configs_scanned": counts["user_profile"],
        "project_configs_scanned": counts["project"],
            "project_ancestor_scan_limit": MAX_PROJECT_ANCESTORS,
            "profile_scan_limit": MAX_PROFILES,
            "profile_scan_truncated": profile_overflow,
            "unreadable_or_oversize_configs": unreadable,
        },
        "mcp_server_table_count": mcp_server_tables,
        "inline_mcp_servers_assignment_detected": inline_mcp_servers,
        "known_environment_variable_presence": env_presence,
        "config_assignment_values_parsed": False,
        "credential_values_parsed": False,
        "credential_values_returned": False,
        "config_values_returned": False,
        "managed_policy_enumerated": False,
        "built_in_tools_enumerated": False,
        "effective_tool_inventory_proven": False,
        "codex_execution_ready": False,
        "unverified_sources": [
            "managed machine and organization policy",
            "built-in Codex tool surface and runtime policy",
            "unlisted environment and parent process configuration",
            "Windows filesystem and process isolation",
        ],
    }
