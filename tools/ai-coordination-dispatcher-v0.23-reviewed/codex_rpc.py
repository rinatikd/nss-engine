"""Fixed-loopback client for the prestarted text-only Codex service.

This module never starts a worker, model, shell, browser, or remote connection.
The JavaScript ledger owns dispatch and ambiguous-delivery recovery.
"""
import http.client
import json
import os
import re
import secrets
from typing import Annotated, Any

from mcp.types import ToolAnnotations
from pydantic import Field

MAX_RESPONSE = 1_000_000
TASK_ID = re.compile(r"codex-[0-9a-f]{32}\Z")
STATES = frozenset(('submitted', 'working', 'input-required', 'completed', 'failed', 'canceled', 'unknown'))


class CodexRPCError(RuntimeError):
    def __init__(self, code, message, status=503, delivery_unknown=False):
        super().__init__(message)
        self.code = code
        self.status = status
        self.delivery_unknown = delivery_unknown


class CodexRPCClient:
    def __init__(self, url=None, token=None, *, timeout=3):
        self.port = None
        self._token = None
        self.timeout = timeout
        self._configuration_error = 'Codex text service is not configured.'
        if url is None and token is None:
            return
        match = re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/?', url or '')
        if (not match or not 1 <= int(match[1]) <= 65535 or not isinstance(token, str)
                or not 24 <= len(token) <= 4096 or any(ord(c) < 33 or ord(c) > 126 for c in token)):
            self._configuration_error = 'Codex service configuration is invalid.'
            return
        self.port = int(match[1])
        self._token = token

    @classmethod
    def from_environment(cls, env=None):
        env = os.environ if env is None else env
        return cls(env.get('A2A_CODEX_RPC_URL'), env.get('A2A_CODEX_RPC_TOKEN'))

    def _require_configured(self):
        if self.port is None:
            raise CodexRPCError('NOT_CONFIGURED', self._configuration_error)

    def _request(self, method, path, body=None, *, mutation=False):
        self._require_configured()
        # HTTPConnection deliberately does not consult proxy environment variables.
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=self.timeout)
        try:
            connection.request(method, path, body=body,
                               headers={'Authorization': 'Bearer ' + self._token,
                                        'Content-Type': 'application/a2a+json', 'Accept': 'application/json'})
            response = connection.getresponse()
            if response.status == 401:
                raise CodexRPCError('UNAUTHORIZED', 'Codex service authentication failed.')
            if response.status != 200:
                # Redirects are rejected; authorization and prompt never go to another URL.
                raise CodexRPCError('HTTP_REJECTED', 'Codex service returned an unexpected HTTP status.',
                                    delivery_unknown=mutation)
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise ValueError('response too large')
            return json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid number')))
        except CodexRPCError:
            raise
        except (OSError, http.client.HTTPException, ValueError, RecursionError, UnicodeError) as exc:
            raise CodexRPCError('DELIVERY_UNKNOWN' if mutation else 'UNAVAILABLE',
                                'Codex service request could not be verified.', delivery_unknown=mutation) from exc
        finally:
            connection.close()

    def _rpc(self, method, params, *, mutation=False):
        request_id = secrets.token_hex(16)
        value = self._request('POST', '/', json.dumps({'jsonrpc': '2.0', 'id': request_id,
                              'method': method, 'params': params}).encode('utf-8'), mutation=mutation)
        if not isinstance(value, dict) or value.get('jsonrpc') != '2.0' or value.get('id') != request_id:
            raise CodexRPCError('INVALID_RESPONSE', 'Codex service response did not match the request.',
                                delivery_unknown=mutation)
        if 'error' in value:
            error = value['error'] if isinstance(value['error'], dict) else {}
            mapping = {-32009: ('TASK_CONFLICT', 'Request ID conflicts with a previous task.', 409),
                       -32001: ('TASK_NOT_FOUND', 'Codex task was not found.', 404),
                       -32002: ('TASK_NOT_CANCELLABLE', 'Codex task cannot be canceled in its current state.', 409),
                       -32602: ('INVALID_TASK', 'Codex service rejected the task parameters.', 400)}
            error_code = error.get('code')
            if not isinstance(error_code, int) or isinstance(error_code, bool):
                error_code = None
            code, message, status = mapping.get(error_code,
                                                ('SERVICE_ERROR', 'Codex service rejected the request.', 503))
            raise CodexRPCError(code, message, status, delivery_unknown=mutation and error_code not in mapping)
        if 'result' not in value or 'error' in value:
            raise CodexRPCError('INVALID_RESPONSE', 'Codex service response was incomplete.',
                                delivery_unknown=mutation)
        return value['result']

    @staticmethod
    def _validate_task_id(task_id):
        if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
            raise ValueError('task_id must be codex- followed by 32 lowercase hexadecimal characters')

    @staticmethod
    def _safe_task(value, expected_id=None):
        if not isinstance(value, dict):
            raise CodexRPCError('INVALID_TASK_RESPONSE', 'Codex service returned an invalid task.')
        task_id = value.get('id')
        if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id) or (expected_id and task_id != expected_id):
            raise CodexRPCError('INVALID_TASK_RESPONSE', 'Codex service returned an unexpected task identifier.')
        state = value.get('status', {}).get('state') if isinstance(value.get('status'), dict) else None
        if not isinstance(state, str) or state not in STATES:
            raise CodexRPCError('INVALID_TASK_RESPONSE', 'Codex service returned an invalid task state.')
        answer, invocation_id = None, None
        artifacts = value.get('artifacts', [])
        if not isinstance(artifacts, list):
            raise CodexRPCError('INVALID_TASK_RESPONSE', 'Codex service returned invalid artifacts.')
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                continue
            for part in artifact.get('parts', []) if isinstance(artifact.get('parts'), list) else []:
                if isinstance(part, dict) and part.get('kind') == 'text' and isinstance(part.get('text'), str):
                    answer = part['text'][:MAX_RESPONSE]
                    break
            metadata = artifact.get('metadata')
            if isinstance(metadata, dict) and isinstance(metadata.get('invocationId'), str):
                invocation_id = metadata['invocationId'][:200]
            if answer is not None:
                break
        return {'task_id': task_id, 'state': state, 'answer': answer, 'invocation_id': invocation_id,
                'human_accepted': False, 'ai_reviewed': False, 'github_published': False}

    def health(self):
        base = {'configured': self.port is not None, 'available': False, 'authentication_verified': False,
                'worker_verified': False, 'execution_ready': False, 'paid_api_allowed': False,
                'windows_execution_allowed': False, 'mode': 'local-text-only', 'local_model_available': None}
        try:
            value = self._request('GET', '/health')
            if not isinstance(value, dict) or value.get('ok') is not True:
                raise CodexRPCError('INVALID_HEALTH', 'Codex service liveness could not be verified.')
            worker_info = value.get('local_worker')
            worker = None
            if isinstance(worker_info, dict) and worker_info.get('provider') == 'ollama-local' and worker_info.get('model') in ('qwen2.5:3b', 'qwen2.5:7b'):
                worker = {'provider': 'ollama-local', 'model': worker_info['model'],
                          'running': worker_info.get('running') is True,
                          'model_available': worker_info.get('model_available') is True,
                          'error_present': bool(worker_info.get('last_error'))}
            result = self._rpc('tasks/list', {'pageSize': 1})
            if not isinstance(result, dict) or not isinstance(result.get('tasks'), list):
                raise CodexRPCError('INVALID_HEALTH', 'Codex service protocol could not be verified.')
            worker = value.get('local_worker')
            model_available = worker.get('model_available') if isinstance(worker, dict) else None
            return {**base, 'available': True, 'authentication_verified': True, 'state': 'SERVICE_AVAILABLE',
                    'local_model_available': model_available if type(model_available) is bool else None,
                    'reason': 'Local service is reachable; worker execution and isolation are not established by health.',
                    'local_worker': worker}
        except CodexRPCError as exc:
            return {**base, 'state': 'BLOCKED', 'reason': str(exc), 'code': exc.code}

    def submit(self, request_id, prompt):
        if not isinstance(request_id, str) or not re.fullmatch(r'[0-9a-fA-F]{32}', request_id):
            raise ValueError('request_id must contain exactly 32 hexadecimal characters')
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 6000:
            raise ValueError('prompt must contain between 1 and 6000 characters')
        task_id = 'codex-' + request_id.lower()
        value = self._rpc('message/send', {'metadata': {'recipient': 'codex'}, 'message': {
            'role': 'user', 'messageId': request_id.lower(), 'taskId': task_id,
            'contextId': task_id, 'parts': [{'kind': 'text', 'text': prompt}]}}, mutation=True)
        try:
            return self._safe_task(value, task_id)
        except CodexRPCError as exc:
            exc.delivery_unknown = True
            raise

    def get(self, task_id):
        self._validate_task_id(task_id)
        return self._safe_task(self._rpc('tasks/get', {'id': task_id}), task_id)

    def cancel(self, task_id):
        self._validate_task_id(task_id)
        value = self._rpc('tasks/cancel', {'id': task_id}, mutation=True)
        try:
            return self._safe_task(value, task_id)
        except CodexRPCError as exc:
            exc.delivery_unknown = True
            raise

    def list_tasks(self):
        """Same-origin UI only; not exposed as an MCP tool."""
        result = self._rpc('tasks/list', {'pageSize': 50})
        if not isinstance(result, dict) or not isinstance(result.get('tasks'), list):
            raise CodexRPCError('INVALID_RESPONSE', 'Codex service returned an invalid task list.')
        tasks = [self._safe_task(value) for value in result['tasks']
                 if isinstance(value, dict) and isinstance(value.get('id'), str) and TASK_ID.fullmatch(value['id'])]
        return {'tasks': tasks}


def client_for(app):
    client = getattr(app, 'codex_client', None)
    if client is None:
        client = CodexRPCClient.from_environment()
        app.codex_client = client
    return client


def register_codex_tools(bridge, app):
    """Expose known-task operations; never spawn processes or list all tasks in MCP."""
    read = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
    write = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)

    @bridge.tool(annotations=read, structured_output=True)
    def dispatcher_codex_health() -> dict[str, Any]:
        """Check the prestarted local text service. Availability is not proof of worker execution or Windows isolation."""
        return client_for(app).health()

    @bridge.tool(annotations=write, structured_output=True)
    def dispatcher_codex_submit_task(request_id: Annotated[str, Field(min_length=32, max_length=32, pattern=r'^[0-9a-fA-F]{32}$')],
                                     prompt: Annotated[str, Field(min_length=1, max_length=6000)]) -> dict[str, Any]:
        """Queue a text-only local Codex task. Reuse request_id on retry; no arbitrary endpoint, shell or Windows runner."""
        return client_for(app).submit(request_id, prompt)

    @bridge.tool(annotations=read, structured_output=True)
    def dispatcher_codex_get_task(task_id: str) -> dict[str, Any]:
        """Get a known Codex task's state and answer. Completion does not mean AI review or human acceptance."""
        return client_for(app).get(task_id)

    @bridge.tool(annotations=write, structured_output=True)
    def dispatcher_codex_cancel_task(task_id: str) -> dict[str, Any]:
        """Cancel a queued task; a task already sent to Codex cannot be revoked through this operation."""
        return client_for(app).cancel(task_id)
