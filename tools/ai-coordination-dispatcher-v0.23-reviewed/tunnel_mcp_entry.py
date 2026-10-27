"""Tunnel stdio child: remove tunnel/admin credentials before starting local MCP."""
import argparse
import os
from pathlib import Path

KEYS = ('CONTROL_PLANE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_ADMIN_KEY')


def scrub_credentials(env):
    return {key: value for key, value in env.items() if key not in KEYS}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--ui-port', type=int, default=8765)
    args = parser.parse_args()
    if not Path(args.db).is_absolute():
        parser.error('Absolute SQLite path required')
    # Exec with a fresh environment so the target process's initial environment
    # also excludes these credentials, rather than only changing os.environ.
    import sys
    command = [sys.executable, '-B', str(Path(__file__).resolve().with_name('unified_runtime.py')),
               '--transport', 'stdio', '--ui-port', str(args.ui_port), '--db', args.db]
    os.execve(sys.executable, command, scrub_credentials(os.environ))


if __name__ == '__main__':
    main()
