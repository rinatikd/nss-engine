"""Real UI HTTP + MCP stdio interoperability; worker inference is mocked."""
import asyncio
import http.client
import json
from pathlib import Path
import re
import socket
import sys
import tempfile
import time
import unittest

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp_bridge import create_bridge
from unified_runtime import UnifiedRuntime
from web_app import Application


class UnifiedRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_ui_and_mcp_share_worker_control(self):
        with tempfile.TemporaryDirectory() as folder:
            db = str(Path(folder) / 'shared.sqlite')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            # Mock only runtime/model execution. Both transports and the actual
            # Application.start/stop/worker_state/settings paths remain real.
            fixture = '''
import sys
from web_app import Application
Application.runtime = lambda self: {'available': True, 'models': ['fixture-writer', 'fixture-reviewer'], 'message': 'offline fixture'}
Application._work = lambda self, mode, agents: self.stop_event.wait(30)
from unified_runtime import main
main(['--db', sys.argv[1], '--ui-port', sys.argv[2]])
'''
            params = StdioServerParameters(command=sys.executable,
                args=['-B', '-c', fixture, db, str(port)], cwd=str(Path(__file__).parent))

            def request(path, data=None, token=None):
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                try:
                    headers = {}
                    if data is not None:
                        headers = {'Content-Type': 'application/json',
                                   'Origin': f'http://127.0.0.1:{port}', 'X-CSRF-Token': token or ''}
                    conn.request('GET' if data is None else 'POST', path,
                                 body=None if data is None else json.dumps(data), headers=headers)
                    response = conn.getresponse()
                    raw = response.read().decode()
                    return response.status, raw if path == '/' else json.loads(raw)
                finally:
                    conn.close()

            async def ui_stopped():
                for _ in range(50):
                    state = request('/api/state')[1]['worker']
                    if not state['running']:
                        return state
                    await asyncio.sleep(.02)
                self.fail('Shared worker did not stop')

            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    code, html = request('/')
                    self.assertEqual(code, 200)
                    token = re.search(r'name="csrf" content="([^"]+)"', html).group(1)
                    start = await session.call_tool('dispatcher_start_local_worker', {
                        'executor_model': 'fixture-writer', 'reviewer_model': 'fixture-reviewer'})
                    self.assertFalse(start.isError)
                    self.assertTrue(start.structuredContent['running'])
                    code, state = request('/api/state')
                    self.assertEqual(code, 200)
                    self.assertTrue(state['worker']['running'])
                    self.assertEqual(state['worker']['mode'], 'local')
                    self.assertEqual(state['settings']['executor_model'], 'fixture-writer')
                    # Existing UI CSRF control stays effective in the combined runtime.
                    self.assertEqual(request('/api/worker/stop', {}, token='wrong')[0], 403)
                    self.assertTrue(request('/api/state')[1]['worker']['running'])
                    code, stopped = request('/api/worker/stop', {}, token=token)
                    self.assertEqual(code, 200)
                    self.assertTrue(stopped['stopping'])
                    await ui_stopped()
                    health = await session.call_tool('dispatcher_health', {})
                    self.assertFalse(health.isError)
                    self.assertFalse(health.structuredContent['worker']['running'])
                    code, restarted = request('/api/worker/start', {'mode': 'local'}, token=token)
                    self.assertEqual(code, 200)
                    self.assertTrue(restarted['running'])
                    health = await session.call_tool('dispatcher_health', {})
                    self.assertTrue(health.structuredContent['worker']['running'])
                    stopped = await session.call_tool('dispatcher_stop_worker', {})
                    self.assertFalse(stopped.isError)
                    self.assertTrue(stopped.structuredContent['stopping'])
                    await ui_stopped()
                    self.assertFalse(health.structuredContent['paid_api_allowed'])

    async def test_shared_application_rejects_another_database(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Application(str(Path(folder) / 'one.sqlite'))
            try:
                with self.assertRaises(ValueError):
                    create_bridge(str(Path(folder) / 'two.sqlite'), application=app)
            finally:
                app.close()

    async def test_runtime_close_releases_ui_listener_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime = UnifiedRuntime(str(Path(folder) / 'one.sqlite'), ui_port=0)
            address = runtime.start_ui()
            port = runtime.server.server_port
            self.assertEqual(runtime.start_ui(), address)
            runtime.close()
            runtime.close()
            self.assertFalse(runtime.ui_thread.is_alive())
            with self.assertRaises(OSError):
                socket.create_connection(('127.0.0.1', port), timeout=.2)
            with self.assertRaises(RuntimeError):
                runtime.start_ui()


if __name__ == '__main__':
    unittest.main()
