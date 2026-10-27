"""Tunnel stdio child: remove tunnel/admin credentials before starting local MCP."""
import argparse
import os
from pathlib import Path
from tunnel_connector import codex_arguments

KEYS = ('CONTROL_PLANE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_ADMIN_KEY')


def scrub_credentials(env):
    return {key: value for key, value in env.items() if key not in KEYS}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--ui-port', type=int, default=8765)
    parser.add_argument('--codex-executable')
    parser.add_argument('--codex-model', choices=('qwen2.5:3b', 'qwen2.5:7b'), default='qwen2.5:3b')
    args = parser.parse_args()
    if not Path(args.db).is_absolute():
        parser.error('Absolute SQLite path required')
    try:
        local_codex = codex_arguments(args.codex_executable, args.codex_model)
    except (ValueError, OSError):
        parser.error('Unsupported local Codex configuration')
    # Exec with a fresh environment so the target process's initial environment
    # also excludes these credentials, rather than only changing os.environ.
    import sys
    command = [sys.executable, '-B', str(Path(__file__).resolve().with_name('run_workspace.py')),
               '--transport', 'stdio', '--ui-port', str(args.ui_port), '--db', args.db, *local_codex]
    os.execve(sys.executable, command, scrub_credentials(os.environ))


if __name__ == '__main__':
    main()
