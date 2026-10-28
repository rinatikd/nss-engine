"""Offline acceptance-boundary regressions; none establishes real inference."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from verify_managed_workspace import RecordingProxy, measured_usage, request_record, validate_records


class BoundaryTests(unittest.TestCase):
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
