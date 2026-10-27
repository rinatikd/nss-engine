import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from web_app import Application, make_server


class WebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Application(str(Path(self.temp.name) / "web.sqlite"))
        self.server = make_server(self.app, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.app.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, data=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": self.app.token}
        h.update(headers or {})
        conn.request("GET" if data is None else "POST", path, body=None if data is None else json.dumps(data), headers=h)
        response = conn.getresponse()
        raw = response.read()
        result = (response.status, raw, dict(response.getheaders()))
        conn.close()
        return result

    def submit(self, **overrides):
        data = dict(task_id="ui-test", prompt="Task", rubric="Rubric", mode="mock", max_revisions=1)
        data.update(overrides)
        status, raw, _ = self.request("/api/tasks", data)
        return status, json.loads(raw)

    def test_html_and_assets_are_served(self):
        status, raw, headers = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(self.app.token.encode(), raw)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        for path in ("/app.js", "/style.css"):
            self.assertEqual(self.request(path)[0], 200)

    def test_browser_can_create_read_cancel_task(self):
        self.assertEqual(self.submit()[0], 200)
        status, raw, _ = self.request("/api/tasks/ui-test")
        self.assertEqual(json.loads(raw)["state"], "QUEUED")
        self.assertEqual(self.request("/api/tasks/ui-test/cancel", {})[0], 200)
        self.assertEqual(json.loads(self.request("/api/tasks/ui-test")[1])["state"], "CANCELLED")

    def test_worker_processes_full_cycle(self):
        self.submit()
        self.assertEqual(self.request("/api/worker/start", {"mode": "mock"})[0], 200)
        for _ in range(70):
            state = json.loads(self.request("/api/tasks/ui-test")[1])
            if state["state"] == "COMPLETED":
                break
            time.sleep(.05)
        self.assertEqual(state["state"], "COMPLETED")
        self.assertEqual(len(state["attempts"]), 4)
        self.assertEqual(self.request("/api/worker/stop", {})[0], 200)

    def test_paid_mode_is_rejected(self):
        self.assertEqual(self.submit(mode="live")[0], 400)
        self.assertEqual(self.request("/api/worker/start", {"mode": "live"})[0], 400)

    def test_csrf_token_required(self):
        self.assertEqual(self.request("/api/worker/start", {"mode": "mock"}, {"X-CSRF-Token": "wrong"})[0], 403)

    def test_foreign_origin_is_rejected(self):
        self.assertEqual(self.request("/api/worker/start", {"mode": "mock"}, {"Origin": "https://example.com"})[0], 403)

    def test_foreign_host_is_rejected(self):
        self.assertEqual(self.request("/api/state", headers={"Host": "example.com"})[0], 403)

    def test_duplicate_id_and_changed_content(self):
        self.assertEqual(self.submit()[1]["status"], "CREATED")
        self.assertEqual(self.submit()[1]["status"], "EXISTS")
        self.assertEqual(self.submit(prompt="Changed")[0], 409)

    def test_settings_persist(self):
        values = {"executor_model": "local-one", "reviewer_model": "local-two"}
        self.assertEqual(self.request("/api/settings", values)[0], 200)
        other = Application(self.app.db)
        try:
            self.assertEqual(other.settings(), values)
        finally:
            other.close()

    def test_invalid_requests_do_not_create_task(self):
        self.assertEqual(self.submit(prompt="")[0], 400)
        self.assertEqual(self.submit(max_revisions=99)[0], 400)
        self.assertEqual(self.request("/api/tasks", ["wrong"])[0], 400)

    def test_missing_task_returns_404(self):
        self.assertEqual(self.request("/api/tasks/missing")[0], 404)

    def test_static_traversal_is_rejected(self):
        self.assertEqual(self.request("/../orchestrator.py")[0], 404)

