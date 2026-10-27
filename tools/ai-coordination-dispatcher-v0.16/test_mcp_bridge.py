import json
from pathlib import Path
import sys
import tempfile
import unittest

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


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
                    self.assertEqual(len(catalog.tools), 7)
                    self.assertTrue(all(t.outputSchema is not None for t in catalog.tools))
                    health = await session.call_tool("dispatcher_health", {})
                    self.assertFalse(health.isError)
                    self.assertFalse(health.structuredContent["paid_api_allowed"])
                    reply = await session.call_tool("dispatcher_submit_task", {
                        "prompt": "Synthetic MCP task", "rubric": "One sentence", "max_revisions": 0})
                    self.assertFalse(reply.isError)
                    task_id = reply.structuredContent["task_id"]
                    saved = await session.call_tool("dispatcher_get_task", {"task_id": task_id})
                    self.assertEqual(saved.structuredContent["state"], "QUEUED")
                    self.assertEqual(saved.structuredContent["spec"]["mode"], "local")
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
