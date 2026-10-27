"""Local browser interface. No paid API, remote bind, or GitHub publication."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json
from pathlib import Path
import secrets
import threading
import time
from urllib.parse import urlsplit, unquote
import webbrowser

from orchestrator import Store, MockAgent, OllamaAgent, step

ROOT = Path(__file__).resolve().parent


class Application:
    def __init__(self, db):
        self.db = str(db)
        Path(db).parent.mkdir(parents=True, exist_ok=True)
        store = self.store()
        store.db.execute("CREATE TABLE IF NOT EXISTS ui_settings (name TEXT PRIMARY KEY,value TEXT NOT NULL)")
        store.close()
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.mode = "mock"
        self.last = None
        self.error = None

    def store(self):
        return Store(self.db)

    def settings(self):
        store = self.store()
        try:
            return dict(store.db.execute("SELECT name,value FROM ui_settings"))
        finally:
            store.close()

    def save_settings(self, values):
        if set(values) != {"executor_model", "reviewer_model"} or any(
            not isinstance(v, str) or not 1 <= len(v.strip()) <= 200 for v in values.values()
        ):
            raise ValueError("Укажите модели исполнителя и рецензента")
        store = self.store()
        try:
            with store.transaction():
                for k, v in values.items():
                    store.db.execute("INSERT INTO ui_settings VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", (k, v.strip()))
        finally:
            store.close()

    def runtime(self):
        conn = http.client.HTTPConnection("127.0.0.1", 11434, timeout=1)
        try:
            conn.request("GET", "/api/tags")
            response = conn.getresponse()
            if response.status != 200:
                raise ValueError("Ollama не ответил")
            data = json.loads(response.read(1_000_000))
            models = [m["name"] for m in data.get("models", []) if isinstance(m, dict) and isinstance(m.get("name"), str)]
            return {"available": True, "models": models, "message": "Локальный сервер доступен"}
        except (OSError, ValueError, http.client.HTTPException):
            return {"available": False, "models": [], "message": "Ollama не запущен на этой машине"}
        finally:
            conn.close()

    def worker_state(self):
        return {"running": bool(self.thread and self.thread.is_alive()), "stopping": self.stop_event.is_set(),
                "mode": self.mode, "last": self.last, "error": self.error}

    def start(self, mode):
        if mode not in ("mock", "local"):
            raise ValueError("Доступны только демо и локальные модели; платные API отключены")
        with self.lock:
            if self.thread and self.thread.is_alive():
                if mode != self.mode:
                    raise ValueError("Сначала остановите текущий worker")
                return self.worker_state()
            if mode == "local":
                settings = self.settings()
                health = self.runtime()
                if not health["available"]:
                    raise ValueError("Запустите Ollama на этой машине, затем обновите статус")
                if any(settings.get(role + "_model") not in health["models"] for role in ("executor", "reviewer")):
                    raise ValueError("Сохраните две модели из списка установленных моделей Ollama")
                agents = {role: OllamaAgent(role, settings[role + "_model"]) for role in ("executor", "reviewer")}
            else:
                agents = {role: MockAgent(role) for role in ("executor", "reviewer")}
            self.mode, self.last, self.error = mode, None, None
            self.stop_event.clear()
            self.thread = threading.Thread(target=self._work, args=(mode, agents), daemon=True)
            self.thread.start()
            return self.worker_state()

    def _work(self, mode, agents):
        store = self.store()
        try:
            while not self.stop_event.is_set():
                self.last = step(store, agents, mode)
                self.stop_event.wait(0.5)
        except Exception:
            self.error = "Worker остановлен из-за ошибки. Проверьте состояние задачи; повторной отправки не было."
        finally:
            store.close()

    def stop(self):
        self.stop_event.set()
        return self.worker_state()

    def close(self):
        self.stop()
        if self.thread:
            self.thread.join(timeout=2)

    def state(self):
        store = self.store()
        try:
            tasks = []
            for row in store.db.execute("SELECT id,state,revision,spec,updated FROM a2a_tasks ORDER BY updated DESC,id LIMIT 200"):
                spec = json.loads(row["spec"])
                tasks.append({"id": row["id"], "state": row["state"], "revision": row["revision"],
                              "mode": spec["mode"], "prompt": spec["prompt"][:180], "updated": row["updated"]})
        finally:
            store.close()
        return {"tasks": tasks, "worker": self.worker_state(), "runtime": self.runtime(),
                "settings": self.settings(), "paid_api_allowed": False}


def make_server(app, port=8765):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # No prompts or identifiers in server logs.

        def send(self, status, body, mime="application/json; charset=utf-8"):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(body)

        def allowed(self, mutation=False):
            authority = "127.0.0.1:" + str(self.server.server_port)
            if self.headers.get("Host") != authority:
                self.send(403, {"error": "Недопустимый адрес интерфейса"})
                return False
            if mutation and (self.headers.get("Origin") != "http://" + authority or
                             not secrets.compare_digest(self.headers.get("X-CSRF-Token", ""), app.token)):
                self.send(403, {"error": "Обновите страницу интерфейса"})
                return False
            return True

        def do_GET(self):
            if not self.allowed():
                return
            path = urlsplit(self.path).path
            if path == "/":
                html = (ROOT / "ui" / "index.html").read_text().replace("__CSRF_TOKEN__", app.token)
                self.send(200, html.encode("utf-8"), "text/html; charset=utf-8")
            elif path in ("/app.js", "/style.css"):
                self.send(200, (ROOT / "ui" / path[1:]).read_bytes(),
                          "text/javascript; charset=utf-8" if path.endswith(".js") else "text/css; charset=utf-8")
            elif path == "/api/state":
                self.send(200, app.state())
            elif path.startswith("/api/tasks/"):
                store = app.store()
                try:
                    self.send(200, store.status(unquote(path[len("/api/tasks/"):])))
                except ValueError:
                    self.send(404, {"error": "Задача не найдена"})
                finally:
                    store.close()
            else:
                self.send(404, {"error": "Не найдено"})

        def do_POST(self):
            if not self.allowed(mutation=True):
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 100_000 or self.headers.get("Content-Type") != "application/json":
                    raise ValueError("Ожидается JSON до 100 КБ")
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("Ожидается JSON-объект")
                path = urlsplit(self.path).path
                if path == "/api/tasks":
                    if set(data) != {"task_id", "prompt", "rubric", "mode", "max_revisions"} or data["mode"] not in ("mock", "local"):
                        raise ValueError("Неверный формат задачи или недоступный режим")
                    task_id = data["task_id"] or "task-" + secrets.token_hex(6)
                    store = app.store()
                    try:
                        result = store.submit(task_id, data["prompt"], data["rubric"], data["mode"], data["max_revisions"])
                    finally:
                        store.close()
                    self.send(409 if result["status"] == "CONFLICT" else 200, {**result, "task_id": task_id})
                elif path == "/api/settings":
                    app.save_settings(data)
                    self.send(200, {"saved": True})
                elif path == "/api/worker/start":
                    self.send(200, app.start(data.get("mode")))
                elif path == "/api/worker/stop":
                    self.send(200, app.stop())
                elif path.startswith("/api/tasks/") and path.endswith("/cancel"):
                    store = app.store()
                    try:
                        self.send(200, store.cancel(unquote(path[len("/api/tasks/"):-len("/cancel")])))
                    finally:
                        store.close()
                else:
                    self.send(404, {"error": "Не найдено"})
            except (ValueError, TypeError, KeyError, UnicodeError):
                self.send(400, {"error": "Проверьте поля запроса: режим, текст, критерии и число исправлений"})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description="Локальный интерфейс A2A Dispatcher")
    parser.add_argument("--db", default=str(ROOT / "state" / "interface.sqlite"))
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    app = Application(args.db)
    try:
        server = make_server(app, args.port)
    except OSError:
        app.close()
        parser.error("Порт занят. Закройте предыдущий интерфейс или укажите другой --port")
    address = "http://127.0.0.1:" + str(server.server_port)
    print("A2A Dispatcher: " + address + " | Ctrl+C — остановить", flush=True)
    if args.open:
        webbrowser.open(address)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.close()
        server.server_close()


if __name__ == "__main__":
    main()
