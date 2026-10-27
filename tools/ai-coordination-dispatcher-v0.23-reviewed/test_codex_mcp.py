"""Official MCP SDK protocol tests with a synthetic local HTTP service, no CLI/model."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from test_codex_rpc import Fixture, TOKEN


class CodexMCPProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_stdio_tools_forward_stable_known_task_operations_without_private_fields(self):
        service=Fixture()
        self.addCleanup(service.close)
        with tempfile.TemporaryDirectory() as folder:
            env={'A2A_CODEX_RPC_URL':service.url,'A2A_CODEX_RPC_TOKEN':TOKEN,
                 'PYTHONDONTWRITEBYTECODE':'1'}
            if os.environ.get('PYTHONPATH'):env['PYTHONPATH']=os.environ['PYTHONPATH']
            params=StdioServerParameters(command=sys.executable,args=[
                str(Path(__file__).with_name('mcp_bridge.py')),'--db',str(Path(folder)/'mcp.sqlite')],env=env)
            async with stdio_client(params) as (read,write):
                async with ClientSession(read,write) as client:
                    await client.initialize()
                    catalog=await client.list_tools()
                    names=[tool.name for tool in catalog.tools]
                    self.assertIn('dispatcher_codex_submit_task',names)
                    self.assertNotIn('dispatcher_codex_list_tasks',names)
                    health=await client.call_tool('dispatcher_codex_health',{})
                    self.assertFalse(health.isError);self.assertTrue(health.structuredContent['authentication_verified'])
                    self.assertFalse(health.structuredContent['execution_ready'])
                    request={'request_id':'A'*32,'prompt':'PRIVATE protocol fixture task'}
                    first=await client.call_tool('dispatcher_codex_submit_task',request)
                    self.assertFalse(first.isError);task_id=first.structuredContent['task_id']
                    replay=await client.call_tool('dispatcher_codex_submit_task',{**request,'request_id':'a'*32})
                    self.assertEqual(first.structuredContent,replay.structuredContent)
                    self.assertEqual(len(service.tasks),1)
                    conflict=await client.call_tool('dispatcher_codex_submit_task',{**request,'prompt':'changed'})
                    self.assertTrue(conflict.isError)
                    saved=await client.call_tool('dispatcher_codex_get_task',{'task_id':task_id})
                    self.assertFalse(saved.isError)
                    self.assertNotIn('PRIVATE',json.dumps(saved.structuredContent))
                    cancelled=await client.call_tool('dispatcher_codex_cancel_task',{'task_id':task_id})
                    self.assertFalse(cancelled.isError);self.assertEqual(cancelled.structuredContent['state'],'canceled')


if __name__=='__main__':unittest.main()
