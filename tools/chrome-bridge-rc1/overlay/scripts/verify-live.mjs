// Contacts only the configured loopback MCP bridge. Reports contain allowlisted
// observations, never page text, prompts, replies, selectors, URLs or credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REQUIRED_TOOLS = Object.freeze([
  'codex_submit', 'codex_job', 'codex_cancel',
  'browser_status', 'browser_tabs', 'browser_open', 'browser_read', 'browser_wait', 'browser_click', 'browser_fill',
  'agent_list', 'agent_bind', 'agent_new_chat', 'agent_send', 'agent_wait', 'agent_ask', 'agent_peek', 'agent_selftest',
]);
class AcceptanceError extends Error {}
const fail = code => { throw new AcceptanceError(code); };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export async function verifyLive({ config, port = 17381, agent, sendTest = false, timeoutSec = 120, beforeSend = async () => {} } = {}) {
  const report = {
    schemaVersion: 1, checkedAt: new Date().toISOString(), passed: false,
    evidenceSource: 'configured-local-bridge-responses',
    authenticatedMcp: false, requiredToolsPresent: false, chromeConnected: false,
    readableStateVerified: false, boundAgentCount: null, selectedAgentBound: false,
    selectors: null, selectorReadiness: 'NOT_CHECKED',
    sendTest: { requested: sendTest, attempted: false, nonceObserved: false, requestId: null,
      deliveryStatus: 'UNKNOWN', replyAttribution: 'UNVERIFIED', autoResend: false },
    functionalAgentObserved: false, fullyTestedAgent: false,
    limitations: ['Bridge responses do not independently prove a real browser or live website.',
      'Selector counts do not prove send permission or successful submission.',
      'Nonce observation is functional evidence only; delivery and reply attribution remain unverified.'],
    failureCode: null,
  };
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) fail('NODE_22_REQUIRED');
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('INVALID_PORT');
    if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) fail('INVALID_TIMEOUT');
    if (agent !== undefined && !/^[a-z0-9_-]{1,32}$/.test(agent)) fail('INVALID_AGENT_NAME');
    if (sendTest && !agent) fail('SEND_TEST_REQUIRES_AGENT');
    if (!config || ![config.agentToken, config.browserToken].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) fail('PRIVATE_CONFIG_INVALID');
    let sequence = 0;
    const deadline = Date.now() + timeoutSec * 1000;
    async function rpc(method, params) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail('ACCEPTANCE_TIMEOUT');
      const id = ++sequence;
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(60000, remaining)),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.agentToken}` },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        });
      } catch { fail('LOCAL_BRIDGE_UNREACHABLE_OR_TIMEOUT'); }
      if (!response.ok) fail('LOCAL_BRIDGE_HTTP_REJECTED');
      let envelope;
      try { envelope = await response.json(); } catch { fail('MCP_RESPONSE_INVALID'); }
      if (envelope.jsonrpc !== '2.0' || envelope.id !== id || envelope.error || !Object.hasOwn(envelope, 'result')) fail('MCP_RESPONSE_REJECTED');
      return envelope.result;
    }
    async function tool(name, args = {}) {
      const result = await rpc('tools/call', { name, arguments: args });
      if (result?.isError) fail('MCP_TOOL_REJECTED');
      try { return JSON.parse(result.content.find(item => item.type === 'text').text); }
      catch { fail('MCP_TOOL_RESULT_INVALID'); }
    }
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chrome-bridge-live-acceptance', version: '1.0.0' } });
    if (init?.serverInfo?.name !== 'chrome-bridge' || !init.capabilities?.tools) fail('MCP_SERVER_IDENTITY_UNEXPECTED');
    report.authenticatedMcp = true;
    const listed = await rpc('tools/list', {});
    const names = new Set(Array.isArray(listed?.tools) ? listed.tools.map(item => item.name) : []);
    report.requiredToolsPresent = REQUIRED_TOOLS.every(name => names.has(name));
    if (!report.requiredToolsPresent) fail('REQUIRED_18_TOOLS_MISSING');
    const status = await tool('browser_status');
    report.chromeConnected = status?.connected === true;
    if (!report.chromeConnected) fail('CHROME_DISCONNECTED');
    const agents = await tool('agent_list');
    if (!Array.isArray(agents?.bound) || !Array.isArray(agents?.chatTabs)) fail('AGENT_LIST_INVALID');
    report.boundAgentCount = agents.bound.length;
    report.readableStateVerified = true;
    if (agent) {
      report.selectedAgentBound = agents.bound.some(item => item.name === agent && item.alive === true);
      if (!report.selectedAgentBound) fail('SELECTED_AGENT_NOT_BOUND_OR_ALIVE');
      const selectors = await tool('agent_selftest', { name: agent });
      report.selectors = Object.fromEntries(['composer', 'send', 'stop', 'reply'].map(key => [key, {
        matched: count(selectors?.[key]?.matched), visible: count(selectors?.[key]?.visible),
      }]));
      if (Object.values(report.selectors).some(item => item.matched === null || item.visible === null || item.visible > item.matched)) fail('SELECTOR_COUNTS_INVALID');
      const c = report.selectors;
      report.selectorReadiness = c.composer.visible === 1 && c.send.visible <= 1 && c.stop.visible === 0
        ? (c.send.visible === 1 ? 'READY_FOR_EXPLICIT_TEST' : 'SEND_BUTTON_NOT_VISIBLE_BEFORE_INPUT') : 'NEEDS_REVIEW';
      if (report.selectorReadiness === 'NEEDS_REVIEW') fail('SELECTORS_NOT_READY');
    }
    if (sendTest) {
      const nonce = 'BRIDGE_CHECK_' + crypto.randomBytes(12).toString('hex');
      report.sendTest.requestId = 'acceptance_' + crypto.randomUUID();
      // Persist the stable request ID before the only potentially sending call.
      // If persistence fails, no submission occurs. Never retry this call here.
      report.sendTest.attempted = true;
      await beforeSend(report);
      let observation = await tool('agent_ask', { name: agent, requestId: report.sendTest.requestId,
        text: `Local connection check. Reply with exactly this code and nothing else: ${nonce}`, timeoutSec: 1 });
      let waits = 0;
      while (observation?.done !== true) {
        if (observation?.sent === false) fail('SEND_NOT_OBSERVED_INSPECT_CHAT_DO_NOT_RESEND');
        if (Date.now() >= deadline || waits++ >= 30) fail('REPLY_NOT_OBSERVED_BEFORE_TIMEOUT');
        observation = await tool('agent_wait', { name: agent, timeoutSec: Math.max(1, Math.min(10, Math.floor((deadline - Date.now()) / 1000))) });
      }
      report.sendTest.nonceObserved = typeof observation.reply === 'string' && observation.reply.includes(nonce);
      report.functionalAgentObserved = report.sendTest.nonceObserved;
      if (!report.functionalAgentObserved) fail('EXPECTED_NONCE_NOT_OBSERVED');
    }
    report.passed = true;
  } catch (error) {
    report.failureCode = error instanceof AcceptanceError ? error.message : 'ACCEPTANCE_INTERNAL_ERROR';
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  let output;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--send-test') options.sendTest = true;
    else if (['--agent', '--report', '--timeout-sec'].includes(args[i]) && args[i + 1]) {
      const key = args[i]; const value = args[++i];
      if (key === '--agent') options.agent = value;
      if (key === '--report') output = value;
      if (key === '--timeout-sec') options.timeoutSec = Number(value);
    } else throw new AcceptanceError('INVALID_OPTIONS');
  }
  const stateDir = path.resolve(process.env.CHROME_BRIDGE_HOME || path.join(os.homedir(), '.chrome-bridge'));
  const configPath = path.join(stateDir, 'config.json');
  output = path.resolve(output || path.join('acceptance-reports', `live-${Date.now()}-${crypto.randomUUID()}.json`));
  if (output === configPath) fail('REPORT_MUST_NOT_REPLACE_CONFIG');
  // Exclusively reserve a new report; never overwrite configs or earlier evidence.
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(output, 'wx', 0o600));
  const persist = report => {
    // Atomic replacement keeps the pre-dispatch request ID available if final
    // report writing is interrupted. The target was exclusively reserved above.
    const temporary = output + '.' + crypto.randomUUID() + '.tmp';
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeSync(descriptor, JSON.stringify(report, null, 2) + '\n');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, output);
  };
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* reported as invalid private config */ }
  const report = await verifyLive({ ...options, config, port: Number(process.env.CHROME_BRIDGE_PORT || 17381), beforeSend: persist });
  persist(report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof AcceptanceError ? error.message : 'ACCEPTANCE_REPORT_OR_CONFIG_ERROR');
    process.exitCode = 1;
  });
}
