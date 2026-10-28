"""Real managed launcher acceptance. Requires real local Ollama on port 11435.

The verifier owns port 11434 only as a recording loopback proxy. It never
substitutes a CLI/model response or registers a hosted ChatGPT application.
"""
import argparse
import anyio
from datetime import timedelta
import asyncio
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch
import uuid

from mcp import ClientSession, StdioServerParameters
from mcp.client import stdio as sdk_stdio
from mcp.client.streamable_http import streamablehttp_client

EXPECTED = 'A2A_MANAGED_WORKSPACE_E2E_OK'
MODEL = 'qwen2.5:3b'
MAX_BODY = 1_000_000
MAX_CAPTURE = 2_000_000
TERMINAL = {'completed', 'failed', 'canceled', 'unknown', 'input-required'}
ENV_KEYS = ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP',
            'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
            'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE')


def local_json(port, route, body=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    try:
        connection.request('GET' if body is None else 'POST', route,
                           None if body is None else json.dumps(body).encode(),
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = response.read(MAX_BODY + 1)
        if response.status != 200 or len(data) > MAX_BODY:
            raise ValueError('Local runtime preflight failed')
        return json.loads(data)
    finally:
        connection.close()


def request_record(method, route, headers, body, model=MODEL):
    """Fail closed before forwarding anything beyond the owned loopback proxy."""
    if any(key.lower() in ('authorization', 'x-api-key') for key in headers):
        raise ValueError('Model request contained an authentication header')
    allowed = ((method == 'GET' and route in ('/api/version', '/api/tags', '/v1/models')) or
               (method == 'POST' and route in ('/api/show', '/v1/responses')))
    if not allowed or len(body) > MAX_BODY:
        raise ValueError('Unexpected local model route, method or size')
    if method == 'GET':
        if body:
            raise ValueError('GET model request contained a body')
        return None
    value = json.loads(body)
    if not isinstance(value, dict) or value.get('model') != model:
        raise ValueError('Unexpected local model')
    if route == '/v1/responses':
        if value.get('tools', []) != []:
            raise ValueError('Effective Codex model tools are not empty')
        return {'route': route, 'model': model, 'tool_names': [], 'authorization_present': False}
    return None


def measured_usage(captured):
    for line in captured.decode('utf-8', 'replace').splitlines():
        if not line.startswith('data:'):
            continue
        try:
            event = json.loads(line[5:])
        except ValueError:
            continue
        if event.get('type') == 'response.completed':
            usage = event.get('response', {}).get('usage')
            if isinstance(usage, dict):
                return usage
    return None


class RecordingProxy:
    def __init__(self, *, backend_port=11435, listen_port=11434, model=MODEL):
        if not 1 <= backend_port <= 65535 or backend_port == listen_port:
            raise ValueError('Distinct fixed loopback backend is required')
        self.backend_port, self.model = backend_port, model
        self.records, self.errors = [], []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_GET(self):
                self.forward()

            def do_POST(self):
                self.forward()

            def forward(self):
                connection = None
                record = None
                headers_sent = False
                try:
                    raw_length = self.headers.get('Content-Length', '0')
                    if not raw_length.isdigit() or int(raw_length) > MAX_BODY or self.headers.get('Transfer-Encoding'):
                        raise ValueError('Unsupported model body framing')
                    body = self.rfile.read(int(raw_length))
                    record = request_record(self.command, self.path, dict(self.headers), body, owner.model)
                    if record is not None:
                        owner.records.append(record)
                    connection = http.client.HTTPConnection('127.0.0.1', owner.backend_port, timeout=240)
                    connection.request(self.command, self.path, body=body or None,
                                       headers={'Content-Type': 'application/json', 'Accept': self.headers.get('Accept', '*/*')})
                    response = connection.getresponse()
                    self.send_response(response.status)
                    self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    headers_sent = True
                    captured = bytearray()
                    while True:
                        chunk = response.read1(65536)
                        if not chunk:
                            break
                        if record is not None and len(captured) < MAX_CAPTURE:
                            captured.extend(chunk[:MAX_CAPTURE - len(captured)])
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    if record is not None:
                        record.update(http_status=response.status, usage=measured_usage(captured))
                except Exception:
                    owner.errors.append('Rejected or incomplete local model exchange')
                    if not headers_sent:
                        try:
                            self.send_error(400, 'Local verifier rejected exchange')
                        except OSError:
                            pass
                finally:
                    self.close_connection = True
                    if connection:
                        connection.close()

        self.server = ThreadingHTTPServer(('127.0.0.1', listen_port), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class OwnedProcesses:
    """Observe only the SDK-created launcher's /proc children, never environment or argv."""
    def __init__(self):
        self.process = None
        self.seen = {}
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._watch, daemon=True)
        self.thread.start()

    @staticmethod
    def identity(pid):
        try:
            text = Path(f'/proc/{pid}/stat').read_text()
            tail = text[text.rfind(')') + 2:].split()
            return tail[19], Path(f'/proc/{pid}/comm').read_text().strip()
        except (OSError, IndexError):
            return None

    @staticmethod
    def children(pid):
        found, supported = set(), False
        try:
            tasks = list(Path(f'/proc/{pid}/task').iterdir())
        except OSError:
            tasks = []
        for task in tasks:
            try:
                found.update(int(value) for value in (task / 'children').read_text().split())
                supported = True
            except OSError:
                pass
        if supported:
            return found
        # Some managed kernels omit task/children entirely. Read only the
        # numeric PID/PPID relation from stat, then inspect names/start times
        # only for descendants. No argv, environment or unrelated process
        # details are stored, logged or used for cleanup.
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                text = (entry / 'stat').read_text()
                tail = text[text.rfind(')') + 2:].split()
                if int(tail[1]) == pid:
                    found.add(int(entry.name))
            except (OSError, ValueError, IndexError):
                pass
        return found

    def _watch(self):
        while not self.stop.wait(.025):
            process = self.process
            if process is None:
                continue
            pending = [process.pid]
            visited = set()
            while pending:
                pid = pending.pop()
                if pid in visited:
                    continue
                visited.add(pid)
                identity = self.identity(pid)
                if identity:
                    self.seen[pid] = identity
                # Linux records children on the spawning task, not only the
                # thread-group leader. Go can spawn the MCP backend from any
                # runtime thread; inspect every owned task's child list.
                pending.extend(self.children(pid))

    def close(self):
        self.stop.set()
        self.thread.join(timeout=2)

    def emergency_cleanup(self):
        # Only after a failed acceptance or survivor check. This does not turn
        # a cleanup failure into PASS, and never targets unrelated processes.
        process = self.process
        if process is not None:
            identity = self.identity(process.pid)
            if identity:
                self.seen.setdefault(process.pid, identity)
        for signum in (signal.SIGTERM, signal.SIGKILL):
            for pid in self.remaining():
                if pid != os.getpid() and pid > 1:
                    try:
                        os.kill(pid, signum)
                    except ProcessLookupError:
                        pass
            if signum == signal.SIGTERM:
                time.sleep(.2)

    def remaining(self):
        return [pid for pid, identity in list(self.seen.items()) if self.identity(pid) == identity]


def ui_request(port, route):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    try:
        connection.request('GET', route)
        response = connection.getresponse()
        body = response.read(MAX_BODY + 1)
        if response.status != 200 or len(body) > MAX_BODY:
            raise ValueError('Shared UI request failed')
        return body.decode() if route == '/' else json.loads(body)
    finally:
        connection.close()


async def session_exchange(session, port, timeout, *, initialized=False):
    if not initialized:
        await session.initialize()
    catalog = await session.list_tools()
    names = {tool.name for tool in catalog.tools}
    if not {'dispatcher_codex_health', 'dispatcher_codex_submit_task', 'dispatcher_codex_get_task'} <= names:
        raise ValueError('Managed MCP catalog is missing Codex tools')

    async def call(name, args):
        result = await session.call_tool(name, args)
        if result.isError or not isinstance(result.structuredContent, dict):
            raise ValueError('Managed MCP tool failed: ' + name)
        return result.structuredContent

    health = await call('dispatcher_codex_health', {})
    if not health.get('configured') or not health.get('available') or not health.get('authentication_verified'):
        raise ValueError('Launcher did not configure its own local service')
    if health.get('execution_ready') or health.get('paid_api_allowed') or health.get('windows_execution_allowed'):
        raise ValueError('Health overclaimed execution readiness')
    html = ui_request(port, '/')
    if 'codex-form' not in html:
        raise ValueError('Shared UI lacks the Codex task panel')
    ui_health = ui_request(port, '/api/codex/state')
    if not ui_health.get('configured') or not ui_health.get('available'):
        raise ValueError('UI did not share the managed Codex service')
    request_id = uuid.uuid4().hex
    prompt = 'Return exactly this single line without added punctuation, quotes, explanation or tools:\n' + EXPECTED
    task = await call('dispatcher_codex_submit_task', {'request_id': request_id, 'prompt': prompt})
    task_id = 'codex-' + request_id
    if task.get('task_id') != task_id:
        raise ValueError('Managed MCP returned an unexpected task id')
    replay = await call('dispatcher_codex_submit_task', {'request_id': request_id, 'prompt': prompt})
    if replay.get('task_id') != task_id:
        raise ValueError('Managed MCP replay did not preserve task id')
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = await call('dispatcher_codex_get_task', {'task_id': task_id})
        if task.get('state') in TERMINAL:
            break
        await asyncio.sleep(.1)
    if task.get('state') != 'completed' or task.get('answer') != EXPECTED or not task.get('invocation_id'):
        raise ValueError('Managed Codex task did not complete with the expected real response')
    if task.get('ai_reviewed') or task.get('human_accepted') or task.get('github_published'):
        raise ValueError('CLI completion overclaimed review or acceptance')
    ui_task = ui_request(port, '/api/codex/tasks/' + task_id)
    if ui_task != task:
        raise ValueError('UI and MCP returned different managed results')
    return task, names


async def stop_owned(observer, *, allow_term=False):
    # Stop only this verifier's captured root process. Child manager owns its
    # own shutdown. Survivor checking occurs BEFORE emergency cleanup.
    os.kill(observer.process.pid, signal.SIGTERM)
    await asyncio.wait_for(observer.process.wait(), timeout=25)
    if observer.process.returncode not in ((0, -signal.SIGTERM) if allow_term else (0,)):
        raise ValueError('Managed transport did not acknowledge SIGTERM cleanly')


def assert_ui_closed(port):
    with socket.socket() as connection:
        if connection.connect_ex(('127.0.0.1', port)) == 0:
            raise ValueError('Managed UI listener survived shutdown')


async def managed_exchange(source, executable, root, observer, timeout):
    db = root / 'managed.sqlite'
    parameters = StdioServerParameters(command=sys.executable, args=[
        '-B', str(source / 'run_workspace.py'), '--db', str(db), '--ui-port', '0',
        '--codex-executable', str(executable), '--codex-model', MODEL],
        env={key: os.environ[key] for key in ENV_KEYS if key in os.environ})
    original_create = sdk_stdio._create_platform_compatible_process

    async def observe_create(*args, **kwargs):
        process = await original_create(*args, **kwargs)
        observer.process = process
        return process

    log = root / 'private-launcher.stderr'
    with log.open('w') as errlog, patch.object(sdk_stdio, '_create_platform_compatible_process', observe_create):
        async with sdk_stdio.stdio_client(parameters, errlog=errlog) as (read, write):
            async with ClientSession(read, write) as session:
                # Initialization ensures the UI was started and its banner flushed.
                await session.initialize()
                match = re.search(r'A2A shared UI/MCP runtime: http://127\.0\.0\.1:([0-9]+)', log.read_text())
                if not match:
                    raise ValueError('Managed UI listener was not reported')
                port = int(match[1])
                task, names = await session_exchange(session, port, timeout, initialized=True)
            await stop_owned(observer)
    assert_ui_closed(port)
    return task, names, db


async def tunneled_exchange(source, executable, client, root, observer, timeout):
    from tunnel_connector import build_profile, runtime_environment
    db = root / 'managed.sqlite'
    profile = root / 'private-profile.yaml'
    connection_file = root / 'private-connection.json'
    log = root / 'private-tunnel.log'
    port = 18765  # The isolated CI job owns this port; fail rather than steal a listener.
    profile.write_text(build_profile(str(db), str(source), sys.executable, 'tunnel_' + '0' * 32,
                                    port, codex_executable=str(executable), codex_model=MODEL))
    env = runtime_environment({key: os.environ[key] for key in ENV_KEYS if key in os.environ})
    env.pop('CONTROL_PLANE_API_KEY', None)
    command = [str(client), 'dev', 'proxy', '--backend', 'go', '--profile-file', str(profile),
               '--listen', '127.0.0.1:0', '--url-file', str(connection_file), '--duration', str(timeout + 40) + 's',
               '--readiness-timeout', '20s', '--response-timeout', '20s']
    with log.open('wb') as output:
        process = await anyio.open_process(command, stdin=subprocess.DEVNULL, stdout=output,
                                           stderr=output, env=env, start_new_session=True)
        observer.process = process
        async with process:
            try:
                deadline = time.monotonic() + 25
                while not connection_file.exists():
                    if process.returncode is not None or time.monotonic() >= deadline:
                        raise ValueError('Official local tunnel did not become ready')
                    await asyncio.sleep(.1)
                info = json.loads(connection_file.read_text())
                url = info.get('mcp_url') or info.get('mcpUrl') or info.get('url')
                from urllib.parse import urlsplit
                address = urlsplit(url or '')
                if address.scheme != 'http' or address.hostname != '127.0.0.1' or address.username or address.password:
                    raise ValueError('Official dev tunnel did not report an owned loopback MCP endpoint')
                async with streamablehttp_client(url, timeout=timedelta(seconds=25)) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        task, names = await session_exchange(session, port, timeout)
                await stop_owned(observer, allow_term=True)
            finally:
                if process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=25)
                    except TimeoutError:
                        process.kill()
                        await process.wait()
    assert_ui_closed(port)
    return task, names, db


def validate_records(proxy):
    if proxy.errors:
        raise ValueError('A local runtime exchange violated the acceptance boundary')
    if len(proxy.records) != 1:
        raise ValueError('Expected exactly one real model request despite MCP replay')
    record = proxy.records[0]
    usage = record.get('usage') or {}
    if (record.get('http_status') != 200 or record.get('tool_names') != [] or
            record.get('authorization_present') is not False or
            type(usage.get('output_tokens')) is not int or usage['output_tokens'] < 1):
        raise ValueError('Measured tool-free local inference was not established')
    return record


def persisted_once(db, task):
    codex_db = db.with_name(db.stem + '-codex.sqlite')
    connection = sqlite3.connect(codex_db)
    try:
        row = connection.execute('SELECT state FROM tasks WHERE id=?', (task['task_id'],)).fetchone()
        events = connection.execute("SELECT body FROM events WHERE task_id=? AND kind='completed'", (task['task_id'],)).fetchall()
        if row != ('completed',) or len(events) != 1 or json.loads(events[0][0])['artifact']['text'] != EXPECTED:
            raise ValueError('Managed completion was not persisted exactly once')
    finally:
        connection.close()


def verify(source, executable, timeout, tunnel_client=None):
    if sys.platform != 'linux' or not executable.is_absolute() or not executable.is_file():
        raise ValueError('Linux and an absolute native Codex executable are required')
    version = subprocess.run([str(executable), '--version'], capture_output=True, text=True, timeout=5, check=False)
    if version.returncode or not re.fullmatch(r'codex-cli 0\.163\.0\s*', version.stdout):
        raise ValueError('Pinned tested native Codex version is required')
    runtime = local_json(11435, '/api/version')
    models = local_json(11435, '/api/tags').get('models', [])
    installed = next((model for model in models if model.get('name') == MODEL), None)
    if not installed or not re.fullmatch('[a-f0-9]{64}', installed.get('digest', '')):
        raise ValueError('Completely installed local model digest is required')
    metadata = local_json(11435, '/api/show', {'model': MODEL})
    if metadata.get('remote_host') or metadata.get('remote_model') or not metadata.get('model_info'):
        raise ValueError('Remote/cloud model metadata is prohibited')
    if tunnel_client is not None:
        if not tunnel_client.is_absolute() or not tunnel_client.is_file():
            raise ValueError('Absolute official tunnel-client executable required')
        client_version = subprocess.run([str(tunnel_client), '--version'], capture_output=True, text=True, timeout=5, check=False)
        if client_version.returncode or not re.search(r'\bv?0\.0\.18\b', client_version.stdout):
            raise ValueError('Pinned official tunnel-client version required')
    observer = OwnedProcesses()
    try:
        with tempfile.TemporaryDirectory(prefix='a2a-managed-acceptance-') as directory, RecordingProxy() as proxy:
            exchange = (managed_exchange(source, executable, Path(directory), observer, timeout) if tunnel_client is None else
                        tunneled_exchange(source, executable, tunnel_client, Path(directory), observer, timeout))
            task, tools, db = asyncio.run(exchange)
            record = validate_records(proxy)
            persisted_once(db, task)
            deadline = time.monotonic() + 5
            while observer.remaining() and time.monotonic() < deadline:
                time.sleep(.05)
            if observer.remaining():
                raise ValueError('Owned launcher descendants survived shutdown')
            names = {identity[1] for identity in observer.seen.values()}
            if 'node' not in names or not any('codex' in name for name in names):
                raise ValueError('Managed Node/native Codex lifecycle was not observed')
            return {'passed': True, 'check': 'managed-launcher-ui-mcp-real-codex-ollama',
                    'task': task, 'usage': record['usage'], 'tool_names': record['tool_names'],
                    'model_digest': installed['digest'], 'ollama_version': runtime.get('version'),
                    'codex_version': version.stdout.strip(), 'mcp_tools_count': len(tools),
                    'ui_observed_same_result': True, 'replay_model_requests': len(proxy.records),
                    'durable_completion_events': 1, 'owned_processes_observed': len(observer.seen),
                    'owned_processes_left': 0, 'launcher_exit_code': observer.process.returncode if tunnel_client is None else None,
                    'transport_exit_code': observer.process.returncode,
                    'official_local_tunnel_verified': tunnel_client is not None,
                    'shutdown_signal': 'SIGTERM', 'shutdown_during_inference_verified': False,
                    'hosted_tunnel_verified': False, 'chatgpt_app_verified': False,
                    'windows_isolation_verified': False, 'paid_api_calls': 0}
    finally:
        observer.close()
        observer.emergency_cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex-executable', required=True)
    parser.add_argument('--tunnel-client', help='Optional official0.0.18 dev proxy: local transport only, not hosted app')
    parser.add_argument('--source', default=str(Path(__file__).resolve().parent))
    parser.add_argument('--output', required=True)
    parser.add_argument('--timeout', type=int, default=280)
    args = parser.parse_args()
    if not 10 <= args.timeout <= 600:
        parser.error('timeout must be 10..600 seconds')
    try:
        evidence = verify(Path(args.source).resolve(), Path(args.codex_executable), args.timeout,
                          None if args.tunnel_client is None else Path(args.tunnel_client))
    except Exception as error:
        # Do not forward private stderr, tokens or provider exception payloads.
        reason = str(error) if type(error) is ValueError else type(error).__name__
        evidence = {'passed': False, 'check': 'managed-launcher-ui-mcp-real-codex-ollama',
                    'reason': reason[:300],
                    'chatgpt_app_verified': False, 'hosted_tunnel_verified': False, 'paid_api_calls': 0}
    Path(args.output).write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        value = json.dumps(evidence, ensure_ascii=False).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
        print('::' + ('notice' if evidence['passed'] else 'error') + ' title=A2A managed acceptance::' + value, flush=True)
    print(json.dumps(evidence, ensure_ascii=False))
    return 0 if evidence['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
