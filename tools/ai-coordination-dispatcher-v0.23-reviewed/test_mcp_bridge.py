import json
from pathlib import Path
import sys
import tempfile
import unittest

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from orchestrator import MockAgent, Store


class MCPTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_stdio_protocol_and_durable_task(self):
        with tempfile.TemporaryDirectory() as folder:
            db = str(Path(folder) / "mcp.sqlite")
            script = str(Path(__file__).parent / "mcp_bridge.py")
            params = StdioServerParameters(command=sys.executable, args=[script, "--db", db])
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    catalog = await session.list_tools()
                    self.assertEqual([tool.name for tool in catalog.tools], [
                        "dispatcher_health", "dispatcher_codex_preflight", "dispatcher_codex_config_audit",
                        "dispatcher_codex_sandbox_smoke",
                        "dispatcher_submit_task", "dispatcher_start_local_worker",
                        "dispatcher_get_task", "dispatcher_cancel_task", "dispatcher_stop_worker",
                    ])
                    self.assertTrue(all(t.outputSchema is not None for t in catalog.tools))
                    submit_tool = next(t for t in catalog.tools if t.name == "dispatcher_submit_task")
                    request_id_schema = submit_tool.inputSchema["properties"]["request_id"]
                    self.assertEqual(request_id_schema["minLength"], 32)
                    self.assertEqual(request_id_schema["maxLength"], 32)
                    self.assertEqual(request_id_schema["pattern"], "^[0-9a-fA-F]{32}$")
                    start_tool = next(t for t in catalog.tools if t.name == "dispatcher_start_local_worker")
                    self.assertFalse(start_tool.annotations.idempotentHint)
                    codex = await session.call_tool("dispatcher_codex_preflight", {})
                    self.assertFalse(codex.isError)
                    self.assertFalse(codex.structuredContent["codex_execution_ready"])
                    self.assertNotIn("path", codex.structuredContent)
                    self.assertNotIn("config", str(codex.structuredContent).lower())
                    audit = await session.call_tool("dispatcher_codex_config_audit", {})
                    self.assertFalse(audit.isError)
                    self.assertFalse(audit.structuredContent["effective_tool_inventory_proven"])
                    self.assertNotIn("path", audit.structuredContent)
                    smoke_tool = next(t for t in catalog.tools if t.name == "dispatcher_codex_sandbox_smoke")
                    self.assertFalse(smoke_tool.annotations.readOnlyHint)
                    self.assertFalse(smoke_tool.annotations.idempotentHint)
                    health = await session.call_tool("dispatcher_health", {})
                    self.assertFalse(health.isError)
                    self.assertFalse(health.structuredContent["paid_api_allowed"])
                    reply = await session.call_tool("dispatcher_submit_task", {
                        "request_id": "6f1a9b3c3d254b7c9bde7c5f8a1b2c3d",
                        "prompt": "PRIVATE synthetic MCP task Ω", "rubric": "One sentence", "max_revisions": 0})
                    self.assertFalse(reply.isError)
                    task_id = reply.structuredContent["task_id"]
                    self.assertEqual(len(task_id.removeprefix("mcp-")), 32)
                    replay = await session.call_tool("dispatcher_submit_task", {
                        "request_id": "6f1a9b3c3d254b7c9bde7c5f8a1b2c3d",
                        "prompt": "PRIVATE synthetic MCP task Ω", "rubric": "One sentence", "max_revisions": 0})
                    self.assertEqual(replay.structuredContent, {"status": "EXISTS", "task_id": task_id})
                    conflict = await session.call_tool("dispatcher_submit_task", {
                        "request_id": "6f1a9b3c3d254b7c9bde7c5f8a1b2c3d",
                        "prompt": "different body", "rubric": "One sentence", "max_revisions": 0})
                    self.assertEqual(conflict.structuredContent, {"status": "CONFLICT", "task_id": task_id})
                    invalid = await session.call_tool("dispatcher_submit_task", {
                        "request_id": "gggggggggggggggggggggggggggggggg",
                        "prompt": "must not be queued", "rubric": "One sentence", "max_revisions": 0})
                    self.assertTrue(invalid.isError)
                    # The published contract accepts opaque 32-hex keys, not only UUIDv4.
                    opaque = await session.call_tool("dispatcher_submit_task", {
                        "request_id": "A" * 32, "prompt": "opaque key", "rubric": "brief", "max_revisions": 0})
                    self.assertFalse(opaque.isError)
                    self.assertEqual(opaque.structuredContent["task_id"], "mcp-" + "a" * 32)
                    same = await session.call_tool("dispatcher_submit_task", {
                        "request_id": "a" * 32, "prompt": "opaque key", "rubric": "brief", "max_revisions": 0})
                    self.assertEqual(same.structuredContent["status"], "EXISTS")
                    store = Store(db)
                    try:
                        agents = {role: MockAgent(role) for role in ("executor", "reviewer")}
                        self.assertEqual(store.reserve("local", agents)["task_id"], task_id)
                    finally:
                        store.close()
                    saved = await session.call_tool("dispatcher_get_task", {"task_id": task_id})
                    self.assertEqual(saved.structuredContent["state"], "EXECUTING")
                    self.assertNotIn("spec", saved.structuredContent)
                    self.assertNotIn("attempts", saved.structuredContent)
                    self.assertNotIn("PRIVATE synthetic MCP task", str(saved.structuredContent))
                    cancelled = await session.call_tool("dispatcher_cancel_task", {"task_id": task_id})
                    self.assertEqual(cancelled.structuredContent["state"], "CANCELLED")
            # A new server process can read the same task.
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    saved = await session.call_tool("dispatcher_get_task", {"task_id": task_id})
                    self.assertEqual(saved.structuredContent["state"], "CANCELLED")


if __name__ == "__main__":
    unittest.main()
