"""Explicit local preparation/launch for official tunnel-client 0.0.18. Never creates tunnels."""
import argparse
import getpass
import json
import os
import platform
from pathlib import Path
import re
import shlex
import subprocess
import sys

PROFILE = 'a2a-dispatcher'
KEY = 'CONTROL_PLANE_API_KEY'
CONFIG_PREFIXES = ('CONTROL_PLANE_', 'MCP_', 'HARPOON_', 'HEALTH_', 'ADMIN_UI_',
                   'TUNNEL_CLIENT_', 'CLOUDFLARED_', 'LOG_', 'TRACING_', 'PID_')


def runtime_environment(env):
    # Prevent ambient client settings from replacing the fixed stdio/loopback profile.
    result = {k: v for k, v in env.items() if not k.startswith(CONFIG_PREFIXES) and
              k not in ('ALLOW_REMOTE_UI', 'OPEN_WEB_UI', 'OPENAI_API_KEY', 'OPENAI_ADMIN_KEY')}
    if KEY in env:
        result[KEY] = env[KEY]
    return result



def absolute(value):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError('Absolute paths are required')
    return path


def codex_arguments(executable=None, model='qwen2.5:3b'):
    """Bind only a fixed native Linux local-model backend, never extra CLI switches."""
    if model not in ('qwen2.5:3b', 'qwen2.5:7b'):
        raise ValueError('Unsupported local Codex model')
    if executable is None:
        if model != 'qwen2.5:3b':
            raise ValueError('A Codex model selection requires the native executable')
        return []
    if platform.system() != 'Linux':
        raise ValueError('The optional local Codex backend is verified only on Linux')
    path = absolute(executable)
    if not path.is_file() or path.is_symlink() or not os.access(path, os.X_OK):
        raise ValueError('An existing executable native Codex file is required')
    with path.open('rb') as stream:
        if stream.read(4) != b'\x7fELF':
            raise ValueError('The local Codex backend requires a native Linux executable')
    return ['--codex-executable', str(path), '--codex-model', model]


def build_profile(db, source, python, tunnel_id, ui_port=8765, codex_executable=None, codex_model='qwen2.5:3b'):
    """JSON is also valid YAML; store no credential values in this profile."""
    if not re.fullmatch(r'tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}', tunnel_id or ''):
        raise ValueError('A real Platform tunnel ID is required')
    if not isinstance(ui_port, int) or not 0 <= ui_port <= 65535:
        raise ValueError('Invalid UI port')
    args = [str(absolute(python)), '-B', str(absolute(source) / 'tunnel_mcp_entry.py'), '--ui-port', str(ui_port), '--db', str(absolute(db))]
    args.extend(codex_arguments(codex_executable, codex_model))
    command = subprocess.list2cmdline(args) if os.name == 'nt' else shlex.join(args)
    profile = {'config_version': 1,
               'control_plane': {'base_url': 'https://api.openai.com', 'tunnel_id': tunnel_id,
                                 'api_key': 'env:' + KEY},
               'health': {'listen_addr': '127.0.0.1:0'},
               'admin_ui': {'open_browser': False},
               'log': {'level': 'warn', 'format': 'json'},
               'mcp': {'commands': [{'channel': 'main', 'command': command}]}}
    return json.dumps(profile, indent=2, ensure_ascii=True) + '\n'


def inspect(client, profile_file, expected, env=None, runner=subprocess.run):
    env = os.environ if env is None else env
    path = absolute(client)
    checks = {'client_file': path.is_file() and not path.is_symlink(), 'client_version': False,
              'profile_matches': False, 'runtime_key_present': bool(env.get(KEY, '').strip())}
    if checks['client_file']:
        try:
            result = runner([str(path), '--version'], capture_output=True, text=True, timeout=10, check=False)
            checks['client_version'] = result.returncode == 0 and bool(re.search(r'\bv?0\.0\.18\b', result.stdout or ''))
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        file = absolute(profile_file)
        checks['profile_matches'] = not file.is_symlink() and file.read_text(encoding='utf-8') == expected
    except OSError:
        pass
    return {'state': 'LOCAL_PREREQUISITES_READY' if all(checks.values()) else 'BLOCKED',
            'checks': checks, 'network_verified': False, 'chatgpt_app_verified': False,
            'binary_publisher_verified': False, 'tunnel_created': False}


def prepare(file, content):
    file = absolute(file)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Exclusive creation preserves existing operator configuration.
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
        stream.write(content)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'check', 'doctor', 'run'))
    parser.add_argument('--client', required=True, help='Absolute path to verified official tunnel-client')
    parser.add_argument('--db', required=True, help='Same absolute SQLite path as the local UI')
    parser.add_argument('--ui-port', type=int, default=8765)
    parser.add_argument('--codex-executable', help='Optional absolute tested0.163 native Linux Codex executable')
    parser.add_argument('--codex-model', choices=('qwen2.5:3b', 'qwen2.5:7b'), default='qwen2.5:3b')
    parser.add_argument('--profile-dir', required=True, help='Private runtime directory, outside source control')
    parser.add_argument('--prompt-key', action='store_true', help='Read runtime key with hidden local prompt')
    args = parser.parse_args(argv)
    try:
        source = Path(__file__).resolve().parent
        if not (source / 'tunnel_mcp_entry.py').is_file() or not (source / 'run_workspace.py').is_file():
            raise ValueError('Install the connector alongside run_workspace.py and tunnel_mcp_entry.py')
        expected = build_profile(args.db, str(source), sys.executable, os.getenv('CONTROL_PLANE_TUNNEL_ID', ''), args.ui_port, args.codex_executable, args.codex_model)
        file = absolute(args.profile_dir) / (PROFILE + '.yaml')
        if args.action == 'prepare':
            prepare(file, expected)
            print(json.dumps({'state': 'PROFILE_PREPARED', 'runtime_key_stored': False, 'tunnel_created': False}))
            return 0
        child_env = runtime_environment(os.environ)
        if args.prompt_key:
            if args.action not in ('doctor', 'run'):
                raise ValueError('Hidden key input is available only for explicit doctor/run')
            if not sys.stdin.isatty():
                raise ValueError('Hidden key input requires an interactive terminal')
            child_env[KEY] = getpass.getpass('Tunnel runtime key (hidden): ')
        status = inspect(args.client, str(file), expected, child_env)
        if status['state'] != 'LOCAL_PREREQUISITES_READY' or args.action == 'check':
            print(json.dumps(status))
            return 0 if status['state'] == 'LOCAL_PREREQUISITES_READY' else 2
        # The key is inherited, never embedded in command arguments or profile contents.
        command = [str(absolute(args.client)), args.action, '--profile-file', str(file)]
        if args.action == 'doctor':
            # Doctor output can contain local config details: return only outcome, not raw logs.
            result = subprocess.run(command + ['--json'], env=child_env, capture_output=True,
                                    timeout=45, check=False)
            print(json.dumps({'state': 'DOCTOR_PASSED' if result.returncode == 0 else 'BLOCKED',
                              'chatgpt_app_verified': False, 'tunnel_created': False}))
            return 0 if result.returncode == 0 else 2
        # Foreground supervision; caller owns Ctrl+C and service lifecycle.
        return subprocess.call(command, env=child_env)
    except KeyboardInterrupt:
        return 130
    except (ValueError, OSError, subprocess.SubprocessError):
        # No exception payloads: environment/provider messages can include sensitive values.
        print(json.dumps({'state': 'BLOCKED', 'reason': 'Local connector validation failed; check paths, ID and profile without sharing secrets.'}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
