// Runs only the synthetic acceptance commands and publishes bounded, redacted evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mode = process.argv[2];
if (process.argv.length !== 3 || !['node-tests', 'synthetic-mv3'].includes(mode)) {
  throw Error('Use node-tests or synthetic-mv3');
}
const candidate = path.resolve(process.env.CANDIDATE_DIR || process.cwd());
const tests = mode === 'node-tests'
  ? fs.readdirSync(path.join(candidate, 'tests')).filter(name => name.endsWith('.test.mjs')).sort()
  : [];
if (mode === 'node-tests' && !tests.length) throw Error('No candidate test files found');
const executable = mode === 'node-tests' ? process.execPath : 'xvfb-run';
const args = mode === 'node-tests'
  ? ['--test', '--test-reporter=tap', ...tests.map(name => 'tests/' + name)]
  : ['-a', process.execPath, 'tests/three-origin-e2e.mjs'];
const child = spawn(executable, args, {
  cwd: candidate, env: { ...process.env, CHROME_BRIDGE_NATIVE_V07: '0' },
  shell: false, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = Buffer.alloc(0);
const limit = 2 * 1024 * 1024;
function capture(chunk) {
  output = Buffer.concat([output, chunk]);
  if (output.length > limit) output = output.subarray(output.length - limit);
}
child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.once('error', error => capture(Buffer.from(`Runner error: ${error.message}\n`)));
child.once('close', (code, signal) => {
  const status = Number.isInteger(code) ? code : 1;
  let evidence = output.toString('utf8')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .split(candidate).join('<candidate>')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:agentToken|browserToken|authorization|api[_-]?key)\b\s*["']?\s*[:=]\s*["']?[^\s,"'<>]+/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED_HEX]');
  const summaryLimit = 80_000;
  if (evidence.length > summaryLimit) evidence = '[Earlier output truncated]\n' + evidence.slice(-summaryLimit);
  const header = `${mode}: exit ${status}${signal ? `, signal ${signal}` : ''}; ${process.platform}; Node ${process.version}; ${tests.length} test files\n`;
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'bridge-ci-evidence-'));
  fs.writeFileSync(path.join(directory, mode + '.log'), header + evidence);
  process.stdout.write(header + evidence);
  if (status !== 0 && process.env.GITHUB_ACTIONS === 'true') {
    // Annotations are visible without opening authenticated Actions logs.
    // Prefer the first TAP failure with its stack; browser failures use the tail.
    const failure = evidence.search(/^not ok\b/m);
    const details = failure >= 0 ? evidence.slice(failure, failure + 5_800) : evidence.slice(-5_800);
    let annotation = '';
    let annotationBytes = 0;
    for (const character of header + details) {
      const escaped = character === '%' ? '%25' : character === '\r' ? '%0D' : character === '\n' ? '%0A' : character;
      const bytes = Buffer.byteLength(escaped);
      if (annotationBytes + bytes > 6_000) break;
      annotation += escaped;
      annotationBytes += bytes;
    }
    process.stdout.write(`::error::${annotation}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Synthetic Chrome Bridge diagnostics\n\n<pre>${escape(header + evidence)}</pre>\n\n` +
      'This evidence uses isolated synthetic fixtures. Native Windows isolation and live provider acceptance are not established.\n');
  }
  process.exitCode = status;
});
