"""Offline acceptance-boundary regressions; none establishes real inference."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import subprocess
import sys
import time
import select
import os
import signal
import shutil
import unittest

from verify_managed_workspace import OwnedProcesses, RecordingProxy, measured_usage, request_record, validate_records


class BoundaryTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux' and shutil.which('node'), 'Linux and Node runtime')
    def test_process_identity_uses_executable_not_main_thread_name(self):
        process = subprocess.Popen(['node', '-e', 'setTimeout(()=>{},30000)'],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
        try:
            time.sleep(.1)
            identity = OwnedProcesses.identity(process.pid)
            self.assertIsNotNone(identity)
            self.assertEqual(identity[1], 'node')
        finally:
            process.terminate()
            process.wait(timeout=3)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux /proc ownership observer')
    def test_observer_tracks_children_created_by_non_main_thread(self):
        fixture = r'''
import subprocess,sys,threading
ready=threading.Event()
child=None
def worker():
    global child
    child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],
                           stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    print(child.pid,flush=True)
    ready.set()
    child.wait()
thread=threading.Thread(target=worker)
thread.start()
ready.wait()
sys.stdin.readline()
child.terminate()
thread.join()
'''
        process = subprocess.Popen([sys.executable, '-c', fixture], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   start_new_session=True)
        observer = OwnedProcesses()
        observer.process = process
        try:
            self.assertTrue(select.select([process.stdout], [], [], 3)[0], 'Fixture did not start')
            child = int(process.stdout.readline())
            deadline = time.monotonic() + 1
            while child not in observer.seen and time.monotonic() < deadline:
                time.sleep(.025)
            self.assertIn(child, observer.seen, 'Worker-thread child was invisible to the observer')
        finally:
            observer.close()
            if process.poll() is None:
                process.stdin.write(b'stop\n')
                process.stdin.flush()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
            process.stdin.close()
            process.stdout.close()

    def request(self, **changes):
        data = dict(model='qwen2.5:3b', tools=[])
        data.update(changes)
        return json.dumps(data).encode()

    def test_tool_free_inference_shape_is_recorded_without_prompt(self):
        record = request_record('POST', '/v1/responses', {}, self.request(input='PRIVATE synthetic request'))
        self.assertEqual(record['tool_names'], [])
        self.assertNotIn('PRIVATE', str(record))

    def test_tools_and_auth_are_rejected(self):
        for headers, body in (({'Authorization': 'Bearer TEST-fixture'}, self.request()),
                              ({'x-api-key': 'TEST-fixture'}, self.request()),
                              ({}, self.request(tools=[{'type': 'function', 'name': 'shell'}]))):
            with self.subTest(headers=headers, body=body), self.assertRaises(ValueError):
                request_record('POST', '/v1/responses', headers, body)

    def test_endpoint_model_and_size_cannot_change(self):
        for method, route, body in (('POST', 'https://example.invalid/v1/responses', self.request()),
                                    ('POST', '/v1/chat/completions', self.request()),
                                    ('POST', '/v1/responses', self.request(model='remote:cloud')),
                                    ('POST', '/v1/responses', b'x' * 1_000_001),
                                    ('GET', '/api/tags', b'not empty')):
            with self.subTest(method=method, route=route), self.assertRaises(ValueError):
                request_record(method, route, {}, body)

    def test_sse_requires_measured_positive_generation(self):
        data = b'data: {"type":"response.completed","response":{"usage":{"output_tokens":11}}}\n\n'
        self.assertEqual(measured_usage(data), {'output_tokens': 11})
        self.assertIsNone(measured_usage(b'data: {"type":"response.created"}\n'))
        class Evidence:
            errors = []
            records = [dict(http_status=200, tool_names=[], authorization_present=False,
                            usage={'output_tokens': 11})]
        self.assertEqual(validate_records(Evidence())['usage']['output_tokens'], 11)
        for usage in ({}, {'output_tokens': 0}, {'output_tokens': True}):
            evidence = Evidence()
            evidence.records = [{**Evidence.records[0], 'usage': usage}]
            with self.subTest(usage=usage), self.assertRaises(ValueError):
                validate_records(evidence)
        evidence = Evidence()
        evidence.records = Evidence.records * 2
        with self.assertRaises(ValueError):
            validate_records(evidence)

    def test_rejected_http_request_never_reaches_backend(self):
        calls = []
        class Backend(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                calls.append(self.path)
                self.send_response(200); self.send_header('Content-Length', '2'); self.end_headers(); self.wfile.write(b'{}')
        backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        thread = threading.Thread(target=backend.serve_forever, daemon=True)
        thread.start()
        try:
            with RecordingProxy(backend_port=backend.server_port, listen_port=0) as proxy:
                connection = http.client.HTTPConnection('127.0.0.1', proxy.server.server_port, timeout=3)
                connection.request('POST', '/v1/responses', self.request(),
                                   {'Authorization': 'Bearer TEST-fixture', 'Content-Type': 'application/json'})
                response = connection.getresponse()
                self.assertEqual(response.status, 400)
                response.read(); connection.close()
                self.assertEqual(calls, [])
                self.assertTrue(proxy.errors)
        finally:
            backend.shutdown(); backend.server_close(); thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
