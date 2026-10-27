#!/usr/bin/env bash
set -euo pipefail
cd /workspace/nss-engine
python3 -c 'import sys; assert sys.version_info >= (3, 12), "Python 3.12+ required"'
python3 -m venv /workspace/.venvs/nss-engine
/workspace/.venvs/nss-engine/bin/python -m pip --no-cache-dir install -r requirements-test.txt
/workspace/.venvs/nss-engine/bin/python -m pip --no-cache-dir check

A2A_SOURCE_DIR=/workspace/a2a-source
A2A_SOURCE_BRANCH=agent/codex/a2a-interface-mcp-v016
if [ ! -e "$A2A_SOURCE_DIR" ]; then
  git clone --depth 1 --single-branch --branch "$A2A_SOURCE_BRANCH" https://github.com/rinatikd/nss-engine.git "$A2A_SOURCE_DIR"
else
  test -d "$A2A_SOURCE_DIR/.git"
  test "$(git -C "$A2A_SOURCE_DIR" remote get-url origin)" = 'https://github.com/rinatikd/nss-engine.git'
  test "$(git -C "$A2A_SOURCE_DIR" branch --show-current)" = "$A2A_SOURCE_BRANCH"
  test -z "$(git -C "$A2A_SOURCE_DIR" status --porcelain)"
  git -C "$A2A_SOURCE_DIR" fetch origin "$A2A_SOURCE_BRANCH"
  git -C "$A2A_SOURCE_DIR" merge --ff-only FETCH_HEAD
fi
A2A_PYTHON_SOURCE="$A2A_SOURCE_DIR/tools/ai-coordination-dispatcher-v0.23-reviewed"
python3 -m venv /workspace/.venvs/a2a-interface
/workspace/.venvs/a2a-interface/bin/python -m pip --no-cache-dir install -r "$A2A_PYTHON_SOURCE/requirements-interface.lock"
/workspace/.venvs/a2a-interface/bin/python -m pip --no-cache-dir check
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || (major===22 && minor<13)) process.exit(2)'

