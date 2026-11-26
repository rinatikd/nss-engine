import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../server/bridge.mjs';

const config = {
  agentToken: 'a'.repeat(64),
  browserToken: 'b'.repeat(64),
  extensionId: 'a'.repeat(32)
};

async function withServer(run) {
  const server = createBridge(config, { timeout: 200, pollHold: 100 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body, token = config.agentToken, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers },
      body: JSON.stringify(body)
    });
  try { await run(post); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const request = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const call = (name, args = {}) => request('tools/call', { name, arguments: args });

test('MCP initialize, ping and status work without an attached Chrome browser', async () => {
  await withServer(async (post) => {
    const initResponse = await post('/mcp', request('initialize', { protocolVersion: '2025-06-18' }));
    assert.equal(initResponse.status, 200);
    const init = await initResponse.json();
    assert.equal(init.result.serverInfo.name, 'chrome-bridge');
    assert.equal(init.result.protocolVersion, '2025-06-18');

    const pingResponse = await post('/mcp', request('ping'));
    assert.equal(pingResponse.status, 200);
    assert.deepEqual((await pingResponse.json()).result, {});

    const listResponse = await post('/mcp', request('tools/list'));
    assert.equal(listResponse.status, 200);
    const listing = await listResponse.json();
    assert.ok(listing.result.tools.some((tool) => tool.name === 'browser_status'));

    const statusResponse = await post('/mcp', call('browser_status'));
    assert.equal(statusResponse.status, 200);
    const statusRpc = await statusResponse.json();
    assert.equal(statusRpc.result.isError, undefined);
    const status = JSON.parse(statusRpc.result.content[0].text);
    assert.equal(status.connected, false);
    assert.equal(status.queued, 0);
    assert.deepEqual(status.agents, []);

    // Browser inventory depends on an active browser, but its MCP call
    // must produce a structured tool error rather than a transport failure.
    const agentListResponse = await post('/mcp', call('agent_list'));
    assert.equal(agentListResponse.status, 200);
    const agentList = await agentListResponse.json();
    assert.equal(agentList.result.isError, true);
    assert.match(agentList.result.content[0].text, /disconnected/i);
  });
});

test('MCP authentication and extension origin pinning do not expose tokens', async () => {
  await withServer(async (post) => {
    assert.equal((await post('/mcp', call('browser_status'), 'wrong')).status, 401);
    assert.equal((await post('/mcp', call('browser_status'), config.browserToken)).status, 401);
    assert.equal((await post('/mcp', call('browser_status'), config.agentToken, { Origin: 'https://example.org' })).status, 403);
    assert.equal((await post('/mcp', call('browser_status'), config.agentToken, { Origin: 'chrome-extension://' + 'b'.repeat(32) })).status, 403);
    const ok = await post('/mcp', call('browser_status'), config.agentToken, { Origin: 'chrome-extension://' + config.extensionId });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse((await ok.json()).result.content[0].text).connected, false);
  });
});
