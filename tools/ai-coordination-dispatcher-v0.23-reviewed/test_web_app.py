import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
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
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.app.close()
        self.temp.cleanup()

    def request(self, path, data=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}", "X-CSRF-Token": self.app.token}
        h.update(headers or {})
        try:
            conn.request("GET" if data is None else "POST", path, body=None if data is None else json.dumps(data), headers=h)
            response = conn.getresponse()
            raw = response.read()
            return (response.status, raw, dict(response.getheaders()))
        finally:
            conn.close()

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

    def test_settings_cannot_change_while_worker_runs(self):
        values = {"executor_model": "local-one", "reviewer_model": "local-two"}
        self.app.save_settings(values)
        self.app.start("mock")
        try:
            with self.assertRaises(ValueError):
                self.app.save_settings({"executor_model": "local-new", "reviewer_model": "local-two"})
            self.assertEqual(self.app.settings(), values)
        finally:
            self.app.stop()
            self.app.thread.join(timeout=5)

    def test_invalid_requests_do_not_create_task(self):
        self.assertEqual(self.submit(prompt="")[0], 400)
        self.assertEqual(self.submit(max_revisions=99)[0], 400)
        self.assertEqual(self.request("/api/tasks", ["wrong"])[0], 400)

    def test_missing_task_returns_404(self):
        self.assertEqual(self.request("/api/tasks/missing")[0], 404)

    def test_static_traversal_is_rejected(self):
        self.assertEqual(self.request("/../orchestrator.py")[0], 404)



class AtomicWorkerStartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Application(str(Path(self.temp.name) / "atomic.sqlite"))
        self.models_a = {"executor_model": "writer-a", "reviewer_model": "reviewer-a"}
        self.models_b = {"executor_model": "writer-b", "reviewer_model": "reviewer-b"}
        self.captured = []
        self.worker_entered = threading.Event()

    def tearDown(self):
        self.app.close()
        self.temp.cleanup()

    def idle_work(self, mode, agents):
        self.captured.append((mode, agents))
        self.worker_entered.set()
        self.app.stop_event.wait(5)

    def health(self):
        return {"available": True, "models": list(self.models_a.values()) + list(self.models_b.values())}

    def test_requested_models_are_bound_to_the_started_worker(self):
        with mock.patch.object(self.app, "runtime", side_effect=self.health), \
             mock.patch.object(self.app, "_work", side_effect=self.idle_work), \
             mock.patch("web_app.OllamaAgent", side_effect=lambda role, model: (role, model)):
            self.assertTrue(self.app.start("local", settings=self.models_a)["running"])
            self.assertTrue(self.worker_entered.wait(2))
            self.assertEqual(self.app.settings(), self.models_a)
            self.assertEqual(self.captured, [("local", {"executor": ("executor", "writer-a"),
                                                       "reviewer": ("reviewer", "reviewer-a")})])
            worker = self.app.thread
            with self.assertRaises(ValueError):
                self.app.start("local", settings=self.models_b)
            self.assertIs(self.app.thread, worker)
            self.assertEqual(self.app.settings(), self.models_a)

    def test_concurrent_configure_start_cannot_replace_first_call_models(self):
        runtime_entered, release_runtime, second_entered, second_done = (threading.Event() for _ in range(4))
        results, failures = {}, {}

        def gated_health():
            runtime_entered.set()
            if not release_runtime.wait(3):
                raise RuntimeError("test runtime gate timed out")
            return self.health()

        def start(label, models):
            if label == "second":
                second_entered.set()
            try:
                results[label] = self.app.start("local", settings=models)
            except Exception as exc:
                failures[label] = exc
            finally:
                if label == "second":
                    second_done.set()

        with mock.patch.object(self.app, "runtime", side_effect=gated_health), \
             mock.patch.object(self.app, "_work", side_effect=self.idle_work), \
             mock.patch("web_app.OllamaAgent", side_effect=lambda role, model: (role, model)):
            first = threading.Thread(target=start, args=("first", self.models_a))
            second = threading.Thread(target=start, args=("second", self.models_b))
            first.start()
            self.assertTrue(runtime_entered.wait(2))
            second.start()
            try:
                self.assertTrue(second_entered.wait(2))
                self.assertFalse(second_done.wait(.05))
            finally:
                release_runtime.set()
                first.join(3)
                second.join(3)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertNotIn("first", failures)
            self.assertTrue(results["first"]["running"])
            self.assertIsInstance(failures.get("second"), ValueError)
            self.assertTrue(self.worker_entered.wait(2))
            self.assertEqual(self.app.settings(), self.models_a)
            self.assertEqual(self.captured[0][1]["executor"], ("executor", "writer-a"))
            self.assertEqual(self.captured[0][1]["reviewer"], ("reviewer", "reviewer-a"))

    def test_unavailable_runtime_does_not_persist_requested_settings(self):
        self.app.save_settings(self.models_a)
        with mock.patch.object(self.app, "runtime", return_value={"available": False, "models": []}):
            with self.assertRaises(ValueError):
                self.app.start("local", settings=self.models_b)
        self.assertEqual(self.app.settings(), self.models_a)
        self.assertIsNone(self.app.thread)
