import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

from mcp.server.fastmcp import FastMCP
from codex_rpc import CodexRPCClient, CodexRPCError, register_codex_tools

TOKEN = 'test-only-codex-rpc-token-32-characters'
TASK_ID = 'codex-' + 'a' * 32


class Fixture:
    def __init__(self):
        self.calls = []
        self.tasks = {}
        self.mode = 'normal'
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def reply(self, status, value):
                data=json.dumps(value).encode();self.send_response(status)
                self.send_header('Content-Length', str(len(data)));self.end_headers();self.wfile.write(data)
            def do_GET(self):
                outer.calls.append(('GET', self.path))
                self.reply(200, {'ok': True, **({'local_worker': {'model_available': outer.mode == 'model_available'}} if outer.mode in ('model_available', 'model_unavailable') else {})})
            def do_POST(self):
                request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                outer.calls.append(('POST', self.path, request))
                if self.headers.get('Authorization') != 'Bearer ' + TOKEN:
                    return self.reply(401, {'error': 'raw backend secret must not escape'})
                if outer.mode == 'redirect':
                    self.send_response(307);self.send_header('Location','http://example.invalid/leak');self.send_header('Content-Length','0');self.end_headers();return
                if outer.mode == 'oversized':
                    return self.reply(200, {'large': 'x' * 1_000_001})
                method=request['method'];params=request['params'];error=None
                if method=='tasks/list': result={'tasks': list(outer.tasks.values())}
                elif method=='message/send':
                    message=params['message'];tid=message['taskId'];prompt=message['parts'][0]['text']
                    if tid in outer.tasks and outer.tasks[tid]['private_prompt'] != prompt:
                        error={'code': -32009, 'message': 'private conflict details'};result=None
                    else:
                        result=outer.tasks.setdefault(tid,{'id':tid,'status':{'state':'submitted'},'private_prompt':prompt,'private_rubric':'private'})
                elif method=='tasks/get':
                    result=outer.tasks.get(params['id'])
                    if result is None:error={'code':-32001,'message':'private not found'}
                elif method=='tasks/cancel':
                    result=outer.tasks[params['id']];result['status']['state']='canceled'
                if outer.mode=='malformed_error':error={'code': [], 'message': 'private malformed server error'}
                if outer.mode=='wrong_id':request['id']='unrelated'
                value={'jsonrpc':'2.0','id':request['id']}
                value['error' if error else 'result']=error if error else result
                self.reply(200,value)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.server.server_port}/'
    def close(self):self.server.shutdown();self.server.server_close();self.thread.join()


class CodexRPCTests(unittest.TestCase):
    def setUp(self):self.fixture=Fixture();self.client=CodexRPCClient(self.fixture.url,TOKEN)
    def tearDown(self):self.fixture.close()

    def test_default_and_invalid_config_never_connect(self):
        invalid=['https://127.0.0.1:1/','http://localhost:1/','http://127.0.0.2:1/',
                 'http://example.com:1/','http://127.0.0.1:1/evil','http://127.0.0.1:1/?x',
                 'http://user@127.0.0.1:1/','http://127.0.0.1:0/','http://127.0.0.1:65536/',
                 'http://127.0.0.1:1/#x','http://127.0.0.1/']
        with patch('codex_rpc.http.client.HTTPConnection') as connect:
            for url in invalid:
                with self.subTest(url=url):self.assertEqual(CodexRPCClient(url,TOKEN).health()['state'],'BLOCKED')
            self.assertFalse(CodexRPCClient.from_environment({}).health()['configured'])
            self.assertFalse(CodexRPCClient(self.fixture.url,'x\r\nHeader: injected').health()['configured'])
            connect.assert_not_called()

    def test_health_authenticates_without_claiming_worker_execution(self):
        result=self.client.health()
        self.assertTrue(result['available']);self.assertTrue(result['authentication_verified'])
        self.assertFalse(result['worker_verified']);self.assertFalse(result['execution_ready'])
        self.assertFalse(result['paid_api_allowed']);self.assertNotIn(TOKEN,str(result))

    def test_health_reports_model_availability_without_claiming_execution(self):
        for mode, expected in (('model_available', True), ('model_unavailable', False)):
            self.fixture.mode = mode
            result = self.client.health()
            self.assertIs(result['local_model_available'], expected)
            self.assertTrue(result['available'])
            self.assertFalse(result['execution_ready'])
        self.fixture.mode = 'normal'
        self.assertIsNone(self.client.health()['local_model_available'])

    def test_stable_id_case_and_conflict_are_preserved(self):
        first=self.client.submit('A'*32,'private task prompt')
        replay=self.client.submit('a'*32,'private task prompt')
        self.assertEqual(first,replay);self.assertEqual(first['task_id'],TASK_ID)
        self.assertEqual(len(self.fixture.tasks),1)
        with self.assertRaises(CodexRPCError) as conflict:self.client.submit('a'*32,'changed')
        self.assertEqual(conflict.exception.status,409);self.assertEqual(conflict.exception.code,'TASK_CONFLICT')
        self.assertFalse(conflict.exception.delivery_unknown)
        request=self.fixture.calls[0][2]
        self.assertEqual(request['params']['metadata']['recipient'],'codex')
        self.assertNotIn('private',str(first))

    def test_known_task_results_and_ui_list_omit_private_fields(self):
        self.client.submit('a'*32,'private task prompt')
        self.fixture.tasks[TASK_ID].update(status={'state':'completed'},artifacts=[{
            'parts':[{'kind':'text','text':'Synthetic result'}],
            'metadata':{'invocationId':'actual-session-id','secret':'private metadata'}}])
        result=self.client.get(TASK_ID)
        self.assertEqual(result['answer'],'Synthetic result');self.assertEqual(result['invocation_id'],'actual-session-id')
        self.assertFalse(result['ai_reviewed']);self.assertFalse(result['human_accepted'])
        self.assertNotIn('private',str(result));self.assertEqual(self.client.list_tasks(),{'tasks':[result]})

    def test_cancel_remains_queued_state_operation(self):
        self.client.submit('a'*32,'prompt')
        self.assertEqual(self.client.cancel(TASK_ID)['state'],'canceled')

    def test_bad_inputs_and_cross_namespace_ids_never_send(self):
        for key in ('a'*31,'g'*32,'a'*33):
            with self.assertRaises(ValueError):self.client.submit(key,'prompt')
        for prompt in ('',' ','x'*6001):
            with self.assertRaises(ValueError):self.client.submit('a'*32,prompt)
        for task in ('mcp-'+'a'*32,'codex-'+'A'*32,'../../path'):
            with self.assertRaises(ValueError):self.client.get(task)
        self.assertEqual(self.fixture.calls,[])

    def test_redirect_is_rejected_without_follow_or_replay(self):
        self.fixture.mode='redirect'
        with self.assertRaises(CodexRPCError) as stopped:self.client.submit('a'*32,'private')
        self.assertTrue(stopped.exception.delivery_unknown);self.assertEqual(len(self.fixture.calls),1)
        self.assertNotIn('private',str(stopped.exception))

    def test_unverified_mutation_response_retains_unknown_delivery(self):
        self.fixture.mode='wrong_id'
        with self.assertRaises(CodexRPCError) as stopped:self.client.submit('a'*32,'private')
        self.assertTrue(stopped.exception.delivery_unknown)
        self.assertEqual(len(self.fixture.tasks),1)
        self.assertEqual(len(self.fixture.calls),1)

    def test_malformed_error_code_is_safe_and_mutation_delivery_unknown(self):
        self.fixture.mode='malformed_error'
        with self.assertRaises(CodexRPCError) as stopped:self.client.submit('a'*32,'private')
        self.assertEqual(stopped.exception.code,'SERVICE_ERROR')
        self.assertTrue(stopped.exception.delivery_unknown)
        self.assertNotIn('private',str(stopped.exception))

    def test_malformed_task_state_is_safe(self):
        self.client.submit('a'*32,'private')
        self.fixture.tasks[TASK_ID]['status']['state']=[]
        with self.assertRaises(CodexRPCError):self.client.get(TASK_ID)

    def test_oversized_response_is_not_trusted_or_returned(self):
        self.fixture.mode='oversized'
        with self.assertRaises(CodexRPCError):self.client.get(TASK_ID)

    def test_authentication_error_does_not_leak_backend_message(self):
        client=CodexRPCClient(self.fixture.url,TOKEN+'wrong')
        result=client.health();self.assertFalse(result['available'])
        self.assertEqual(result['code'],'UNAUTHORIZED');self.assertNotIn('raw backend',str(result))


class ToolCatalogTests(unittest.IsolatedAsyncioTestCase):
    async def test_codex_tools_are_fixed_scope_and_known_task_only(self):
        class App:codex_client=CodexRPCClient.from_environment({})
        server=FastMCP('test');register_codex_tools(server,App())
        tools=await server.list_tools();self.assertEqual([t.name for t in tools],[
            'dispatcher_codex_health','dispatcher_codex_submit_task','dispatcher_codex_get_task','dispatcher_codex_cancel_task'])
        submit=tools[1];self.assertTrue(submit.annotations.idempotentHint);self.assertFalse(submit.annotations.readOnlyHint)
        self.assertEqual(set(submit.inputSchema['properties']),{'request_id','prompt'})
        content=await server.call_tool('dispatcher_codex_health',{})
        self.assertIn('BLOCKED',str(content));self.assertNotIn('tasks/list',[t.name for t in tools])


if __name__=='__main__':unittest.main()
