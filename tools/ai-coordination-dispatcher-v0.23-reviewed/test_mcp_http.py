"""Isolated loopback Streamable HTTP MCP round trip; never starts a worker."""

import asyncio
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


class McpHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_submit_get_cancel_over_loopback(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(__file__).parent
            db = Path(folder) / "http.sqlite"
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
            process = subprocess.Popen(
                [sys.executable, "-B", str(root / "mcp_bridge.py"), "--transport", "streamable-http",
                 "--db", str(db), "--port", str(port)],
                cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        self.fail("MCP HTTP server exited during startup")
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                            break
                    except OSError:
                        await asyncio.sleep(0.05)
                else:
                    self.fail("MCP HTTP server did not bind loopback before timeout")

                async with streamable_http_client(f"http://127.0.0.1:{port}/mcp") as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        tools = await session.list_tools()
                        self.assertEqual([tool.name for tool in tools.tools], [
                            "dispatcher_health", "dispatcher_codex_preflight", "dispatcher_codex_config_audit",
                            "dispatcher_codex_sandbox_smoke",
                            "dispatcher_submit_task", "dispatcher_start_local_worker",
                            "dispatcher_get_task", "dispatcher_cancel_task", "dispatcher_stop_worker",
                        "dispatcher_codex_health", "dispatcher_codex_submit_task",
                        "dispatcher_codex_get_task", "dispatcher_codex_cancel_task",
                        ])
                        health = await session.call_tool("dispatcher_health", {})
                        self.assertFalse(health.isError)
                        self.assertFalse(health.structuredContent["paid_api_allowed"])
                        created = await session.call_tool("dispatcher_submit_task", {
                            "request_id": "6f1a9b3c3d254b7c9bde7c5f8a1b2c3e",
                            "prompt": "Synthetic loopback MCP task",
                            "rubric": "Return a short answer", "max_revisions": 0,
                        })
                        self.assertFalse(created.isError)
                        task_id = created.structuredContent["task_id"]
                        queued = await session.call_tool("dispatcher_get_task", {"task_id": task_id})
                        self.assertEqual(queued.structuredContent["state"], "QUEUED")
                        self.assertNotIn("spec", queued.structuredContent)
                        cancelled = await session.call_tool("dispatcher_cancel_task", {"task_id": task_id})
                        self.assertEqual(cancelled.structuredContent["state"], "CANCELLED")
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
