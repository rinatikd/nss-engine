"""Official SDK MCP -> prestarted local JS Codex service synthetic live check.

This verifier never starts Codex itself. A configured external local-only worker
must process the one submitted task. Its result must be combined with independent actual CLI/model evidence;
a session identifier alone is not proof that a model ran.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

EXPECTED = 'A2A_CODEX_LOCAL_E2E_OK'
TERMINAL = frozenset(('completed', 'failed', 'canceled', 'unknown', 'input-required'))


async def verify(db, expected, timeout):
    script = Path(__file__).with_name('unified_runtime.py')
    child_env = {key: os.environ[key] for key in ('PATH', 'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE',
        'A2A_CODEX_RPC_URL', 'A2A_CODEX_RPC_TOKEN', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
        'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE')
        if key in os.environ}
    parameters = StdioServerParameters(command=sys.executable, args=[str(script), '--db', str(db), '--ui-port', '0'], env=child_env)
    started = time.monotonic()
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            catalog = await session.list_tools()
            tools = {tool.name: tool for tool in catalog.tools}
            required = {'dispatcher_codex_health', 'dispatcher_codex_submit_task',
                        'dispatcher_codex_get_task', 'dispatcher_codex_cancel_task'}
            if not required <= tools.keys():
                raise ValueError('Codex tools are missing from the actual MCP catalog')
            if any(name in tools for name in ('dispatcher_codex_list_tasks', 'dispatcher_codex_start_worker')):
                raise ValueError('MCP must not list unrelated tasks or start arbitrary CLI processes')

            async def call(name, arguments):
                result = await session.call_tool(name, arguments)
                if result.isError or not isinstance(result.structuredContent, dict):
                    raise ValueError('MCP tool failed: ' + name)
                return result.structuredContent

            health = await call('dispatcher_codex_health', {})
            if not health.get('available') or not health.get('authentication_verified'):
                raise ValueError('Configured local Codex service is unavailable')
            if health.get('execution_ready') or health.get('paid_api_allowed') or health.get('windows_execution_allowed'):
                raise ValueError('Health must not imply execution or Windows readiness')
            request_id = os.environ.get('A2A_CODEX_TEST_REQUEST_ID') or uuid.uuid4().hex
            prompt = 'Return this marker verbatim as your entire final response, without punctuation, quotes, explanation or tools:\n' + expected
            task = await call('dispatcher_codex_submit_task', {'request_id': request_id, 'prompt': prompt})
            task_id = task.get('task_id')
            if task_id != 'codex-' + request_id.lower():
                raise ValueError('Stable request ID is not bound to the returned task')
            # A replay must resolve to the same task, not create a second inference.
            replay = await call('dispatcher_codex_submit_task', {'request_id': request_id, 'prompt': prompt})
            if replay.get('task_id') != task_id:
                raise ValueError('MCP replay created another task')
            while time.monotonic() - started < timeout:
                task = await call('dispatcher_codex_get_task', {'task_id': task_id})
                if task.get('state') in TERMINAL:
                    break
                await asyncio.sleep(0.2)
            if task.get('state') != 'completed' or task.get('answer') != expected:
                raise ValueError('Actual MCP Codex task did not return the expected completed answer: ' + str(task.get('state')))
            if not isinstance(task.get('invocation_id'), str) or not task['invocation_id']:
                raise ValueError('Actual external Codex session identifier is missing')
            if not set(task) <= {'task_id', 'state', 'answer', 'invocation_id', 'human_accepted', 'ai_reviewed', 'github_published'}:
                raise ValueError('MCP returned private or unexpected task fields')
            if task.get('human_accepted') or task.get('ai_reviewed') or task.get('github_published'):
                raise ValueError('CLI completion must not claim review, acceptance or publication')
            # Verify cancel through MCP on a separate queued task without starting inference.
            # This is deliberately omitted in live worker mode: it could claim immediately.
            return {'passed': True, 'transport': 'official-mcp-sdk-stdio', 'task': task,
                    'request_id': request_id, 'elapsed_seconds': round(time.monotonic()-started, 3),
                    'chatgpt_app_verified': False, 'windows_isolation_verified': False,
                    'paid_api_calls': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', help='Private synthetic fixture database for the MCP Application')
    parser.add_argument('--expected', '--expected-marker', dest='expected', default=EXPECTED)
    parser.add_argument('--timeout', type=float, default=300)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 600 or not 1 <= len(args.expected) <= 200:
        parser.error('Invalid verifier bounds')
    with tempfile.TemporaryDirectory(prefix='a2a-codex-mcp-') as folder:
        db = args.db or str(Path(folder)/'mcp.sqlite')
        try:
            evidence = asyncio.run(verify(db, args.expected, args.timeout))
        except Exception as error:
            # Avoid forwarding tool output, config, URLs, bearer tokens or child stderr.
            print(json.dumps({'passed': False, 'error': str(error)[:300]}), flush=True)
            return 1
        print(json.dumps(evidence, ensure_ascii=False), flush=True)
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
