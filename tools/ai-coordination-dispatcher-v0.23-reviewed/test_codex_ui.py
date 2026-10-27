"""Same-origin UI routes for the separate Codex task ledger; no model/CLI calls."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from codex_rpc import CodexRPCClient, CodexRPCError
from web_app import Application, make_server


class ClientFixture:
    def __init__(self):
        self.calls = []
        self.task = {'task_id': 'codex-' + 'a' * 32, 'state': 'submitted', 'answer': None,
                     'invocation_id': None, 'human_accepted': False, 'ai_reviewed': False}
        self.error = None

    def health(self):
        return {'configured': True, 'available': True, 'state': 'REACHABLE', 'cli_execution_verified': False}

    def list_tasks(self):
        self.calls.append(('list',))
        return {'tasks': [self.task]}

    def submit(self, request_id, prompt):
        self.calls.append(('submit', request_id, prompt))
        if self.error:
            raise self.error
        return dict(self.task)

    def get(self, task_id):
        self.calls.append(('get', task_id))
        if self.error:
            raise self.error
        return dict(self.task)

    def cancel(self, task_id):
        self.calls.append(('cancel', task_id))
        if self.error:
            raise self.error
        return dict(self.task, state='canceled')


class CodexUITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.client = ClientFixture()
        self.app = Application(str(Path(self.temp.name) / 'ui.sqlite'), codex_client=self.client)
        self.server = make_server(self.app, 0)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.app.close()
        self.temp.cleanup()

    def request(self, path, data=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        fields = {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{self.port}',
                  'X-CSRF-Token': self.app.token}
        fields.update(headers or {})
        try:
            conn.request('GET' if data is None else 'POST', path,
                         body=None if data is None else json.dumps(data), headers=fields)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_browser_sees_separate_backend_and_can_submit_get_cancel(self):
        status, health = self.request('/api/codex/state')
        self.assertEqual(status, 200)
        self.assertTrue(health['available'])
        self.assertFalse(health['cli_execution_verified'])
        payload = {'request_id': 'a' * 32, 'prompt': 'Text only <script>alert(1)</script>'}
        status, task = self.request('/api/codex/tasks', payload)
        self.assertEqual(status, 200)
        self.assertEqual(self.client.calls[-1], ('submit', payload['request_id'], payload['prompt']))
        self.assertEqual(self.request('/api/codex/tasks')[1]['tasks'][0], task)
        self.assertEqual(self.request('/api/codex/tasks/' + task['task_id'])[1], task)
        self.assertEqual(self.request('/api/codex/tasks/' + task['task_id'] + '/cancel', {})[1]['state'], 'canceled')
        # Codex tasks never appear as reviewed tasks in the Python ledger.
        self.assertEqual(self.request('/api/state')[1]['tasks'], [])

    def test_cannot_supply_url_cli_args_or_invalid_prompt_in_browser(self):
        for payload in (
            {'request_id': 'a' * 32, 'prompt': 'hi', 'url': 'https://example.com'},
            {'request_id': 'a' * 32, 'prompt': 'hi', 'args': ['--yolo']},
            {'request_id': 'bad', 'prompt': 'hi'},
            {'request_id': 'a' * 32, 'prompt': ''},
            {'request_id': 'a' * 32, 'prompt': 'x' * 6001},
            {'request_id': 'a' * 32, 'prompt': False},
        ):
            with self.subTest(payload=payload):
                self.assertEqual(self.request('/api/codex/tasks', payload)[0], 400)
        self.assertEqual(self.client.calls, [])

    def test_csrf_origin_and_host_checks_prevent_backend_mutations(self):
        body = {'request_id': 'a' * 32, 'prompt': 'hi'}
        for headers in ({'X-CSRF-Token': 'wrong'}, {'Origin': 'https://example.com'}, {'Host': 'example.com'}):
            self.assertEqual(self.request('/api/codex/tasks', body, headers)[0], 403)
        self.assertEqual(self.client.calls, [])

    def test_backend_conflict_and_ambiguous_delivery_are_not_success(self):
        self.client.error = CodexRPCError('TASK_CONFLICT', 'safe fixture', 409)
        status, body = self.request('/api/codex/tasks', {'request_id': 'a' * 32, 'prompt': 'hi'})
        self.assertEqual(status, 409)
        self.assertFalse(body['delivery_unknown'])
        self.client.error = CodexRPCError('DELIVERY_UNKNOWN', 'safe fixture', delivery_unknown=True)
        status, body = self.request('/api/codex/tasks', {'request_id': 'a' * 32, 'prompt': 'hi'})
        self.assertEqual(status, 503)
        self.assertTrue(body['delivery_unknown'])
        self.assertNotIn('safe fixture', json.dumps(body))

    def test_missing_backend_is_explicitly_blocked_without_dispatch(self):
        self.app.codex_client = CodexRPCClient()
        status, health = self.request('/api/codex/state')
        self.assertEqual(status, 200)
        self.assertFalse(health['configured'])
        self.assertFalse(health['available'])
        self.assertFalse(health['execution_ready'])
        self.assertEqual(self.request('/api/codex/tasks', {'request_id': 'a' * 32, 'prompt': 'hi'})[0], 503)
        self.assertEqual(self.client.calls, [])

    def test_cancel_body_cannot_set_backend_options(self):
        self.assertEqual(self.request('/api/codex/tasks/' + self.client.task['task_id'] + '/cancel', {'force': True})[0], 400)
        self.assertEqual(self.client.calls, [])


if __name__ == '__main__':
    unittest.main()
