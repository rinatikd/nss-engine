import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const WORKER = fileURLToPath(new URL('./helpers/worker.mjs', import.meta.url));
export const tmpdb = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return { dir: d, db: path.join(d, 'l.db'), log: path.join(d, 'sends.log') }; };
export const sends = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function run(args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--no-warnings', WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('close', (code, signal) => resolve({ code, signal, out: out.trim(), err: err.trim() }));
  });
}
export const task = (id, over = {}) => ({ id, contextId: 'ctx-1', sender: 'chatgpt', recipient: 'claude', text: 'do the thing ' + id, ...over });
