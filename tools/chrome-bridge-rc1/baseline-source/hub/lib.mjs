// Hub: файловый протокол проекта + цикл «исполнитель → рецензент → доработка».
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * ms * 0.3);

// ---------- клиент MCP моста ----------
export function mcpClient({ url = `http://127.0.0.1:${process.env.CHROME_BRIDGE_PORT || 17381}/mcp`, token }) {
  let id = 0;
  async function call(name, args = {}) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!r.ok) throw Error('Bridge HTTP ' + r.status + ' (is Start-Bridge.ps1 running?)');
    const j = await r.json();
    if (j.error) throw Error(j.error.message);
    const text = j.result?.content?.[0]?.text ?? '';
    if (j.result?.isError) throw Error(text);
    try { return JSON.parse(text); } catch { return text; }
  }
  return { call };
}

// ---------- шаблоны ----------
export function render(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
}
export function deepRender(v, vars) {
  if (typeof v === 'string') return render(v, vars);
  if (Array.isArray(v)) return v.map((x) => deepRender(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRender(x, vars)]));
  return v;
}
const prompt = (name) => fs.readFileSync(path.join(HERE, 'prompts', name), 'utf8');

export const FILE_FORMAT = `Каждый файл оформляй строго так (без markdown-обёртки вокруг маркеров):
=== FILE: относительный/путь/файл.расширение ===
<полное содержимое файла>
=== END FILE ===
Вне блоков FILE пиши только краткие пояснения и раздел «Допущения».`;
export const TEXT_FORMAT = 'Ответь полным готовым текстом в Markdown. В конце добавь раздел «Допущения», если они были.';

// ---------- проект ----------
export class Project {
  constructor(root) { this.root = path.resolve(root); }
  p(...parts) { return path.join(this.root, ...parts); }
  exists(...parts) { return fs.existsSync(this.p(...parts)); }
  read(rel, cap = 20000) { const f = this.p(rel); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').slice(0, cap) : ''; }
  write(rel, data) { const f = this.p(rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); }
  json(rel, fallback) { try { return JSON.parse(fs.readFileSync(this.p(rel), 'utf8')); } catch { return fallback; } }
  saveJson(rel, data) { this.write(rel, JSON.stringify(data, null, 2)); }
  agents() { return this.json('agents.json', {}); }
  taskIds() { return fs.existsSync(this.p('tasks')) ? fs.readdirSync(this.p('tasks')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : []; }
  task(id) { const t = this.json(`tasks/${id}.json`); if (!t) throw Error('Task not found: ' + id); return t; }
  saveTask(t) { this.saveJson(`tasks/${t.id}.json`, t); }
  log(event) { fs.appendFileSync(this.p('LOG.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n'); }
  logEntries() { try { return fs.readFileSync(this.p('LOG.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
}

// ---------- работа с агентом ----------
export class Agents {
  constructor(project, client) { this.project = project; this.client = client; this.cfg = project.agents(); this.last = new Map(); this.sentLog = this.project.logEntries().filter((e) => e.ev === 'send'); }
  conf(name) { const c = this.cfg[name]; if (!c) throw Error(`Agent "${name}" is not described in agents.json`); return c; }
  async gate(name) {
    const c = this.conf(name);
    const gap = (c.min_gap_sec ?? 4) * 1000;
    const wait = (this.last.get(name) || 0) + jitter(gap) - Date.now();
    if (wait > 0) await sleep(wait);
    const cap = c.max_per_hour ?? 40;
    const hourAgo = Date.now() - 3600_000;
    const n = this.sentLog.filter((e) => e.agent === name && Date.parse(e.t) > hourAgo).length;
    if (n >= cap) throw Error(`Hourly message cap reached for ${name} (${cap}). Raise max_per_hour in agents.json or wait.`);
  }
  async ask(name, text, { timeoutMin = 15, label = '' } = {}) {
    await this.gate(name);
    await this.client.call('agent_send', { name, text });
    this.last.set(name, Date.now());
    const e = { ev: 'send', agent: name, label, chars: text.length };
    this.project.log(e); this.sentLog.push({ t: new Date().toISOString(), ...e });
    const end = Date.now() + timeoutMin * 60_000;
    for (;;) {
      const r = await this.client.call('agent_wait', { name, timeoutSec: 50 });
      if (r.done) return r.reply;
      if (Date.now() > end) throw Error(`Timeout waiting for ${name} (${timeoutMin} min)`);
    }
  }
  newChat(name) { return this.client.call('agent_new_chat', { name }); }
  async ensureBound(names) {
    const l = await this.client.call('agent_list');
    for (const n of names) {
      const b = l.bound.find((x) => x.name === n);
      if (!b || !b.alive) throw Error(`Agent "${n}" is not bound to a live chat tab. Open the chat, then: agent_list / agent_bind (see README).`);
    }
  }
}

// ---------- парсинг ответа рецензента ----------
function jsonObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { out.push(text.slice(i, j + 1)); break; }
    }
  }
  return out;
}
export function extractVerdict(text) {
  for (const c of jsonObjects(text).reverse()) {
    try {
      const j = JSON.parse(c);
      if (j && ['accept', 'revise'].includes(j.verdict) && typeof j.score === 'number') {
        return { score: j.score, verdict: j.verdict, must_fix: j.must_fix || [], suggestions: j.suggestions || [], summary: j.summary || '' };
      }
    } catch { /* следующий кандидат */ }
  }
  return null;
}

// ---------- цикл задачи ----------
export async function runTask(project, agents, taskId, { resume = false } = {}) {
  const task = project.task(taskId);
  const cfg = project.agents();
  const A = task.assignee, R = task.reviewer;
  if (!cfg[A]) throw Error(`assignee "${A}" not in agents.json`);
  if (R && R === A) throw Error('Reviewer must differ from assignee');
  const maxRounds = task.max_rounds ?? 4;
  const pass = task.pass_score ?? 8;
  const dir = `runs/${taskId}`;
  let st = resume ? project.json(`${dir}/state.json`) : null;
  if (!st) { st = { round: 1, phase: 'dev', reply: '', feedback: '' }; project.write(`${dir}/state.json`, JSON.stringify(st)); }
  const save = () => project.saveJson(`${dir}/state.json`, st);
  const done = (status, extra = {}) => { Object.assign(task, { status, ...extra, updated: new Date().toISOString() }); project.saveTask(task); project.log({ ev: 'task', id: taskId, status, ...extra }); return task; };

  await agents.ensureBound([A, ...(R ? [R] : [])]);
  task.status = 'running'; project.saveTask(task);
  if (!resume) { if (task.new_chat !== false) { await agents.newChat(A); if (R) await agents.newChat(R); } }

  const depText = (task.deps || []).map((d) => `## Принято: ${d}\n${project.read(`accepted/${d}.md`, 8000)}`).join('\n\n');
  const baseVars = {
    role_preamble: cfg[A].role || '', project: project.read('PROJECT.md', 6000), id: task.id, title: task.title, brief: task.brief,
    pass_score: pass, acceptance: (task.acceptance || []).map((x) => '- ' + x).join('\n') || '- Соответствует заданию',
    deps: depText || '(нет)', output_format: task.output_files ? FILE_FORMAT : TEXT_FORMAT,
  };
  try {
    while (st.round <= maxRounds) {
      if (st.phase === 'dev') {
        const text = st.feedback
          ? render(prompt('revise.md'), { ...baseVars, feedback: st.feedback, round: st.round })
          : render(prompt('assignee.md'), baseVars);
        st.reply = await agents.ask(A, text, { label: `${taskId}/r${st.round}/dev` });
        project.write(`${dir}/round-${st.round}.reply.md`, st.reply);
        if (!R) return done('needs_orchestrator', { rounds: st.round, note: 'no reviewer assigned', last_reply_file: `${dir}/round-${st.round}.reply.md` });
        st.phase = 'review'; save();
      }
      const rv = render(prompt('reviewer.md'), { ...baseVars, round: st.round, rubric: project.read('rubric.md', 4000), candidate: st.reply, previous: st.round > 1 ? 'Это переработанная версия; проверь, что прошлые замечания учтены.' : '' });
      let text = await agents.ask(R, rv, { label: `${taskId}/r${st.round}/review` });
      let v = extractVerdict(text);
      if (!v) { text = await agents.ask(R, prompt('reviewer-reformat.md'), { label: `${taskId}/r${st.round}/reformat` }); v = extractVerdict(text); }
      project.write(`${dir}/round-${st.round}.review.md`, text);
      if (!v) return done('needs_orchestrator', { rounds: st.round, note: 'reviewer verdict not parseable', last_review_file: `${dir}/round-${st.round}.review.md` });
      project.saveJson(`${dir}/round-${st.round}.verdict.json`, v);
      project.log({ ev: 'review', id: taskId, round: st.round, score: v.score, verdict: v.verdict });
      if (v.verdict === 'accept' && v.score >= pass) {
        project.write(`accepted/${taskId}.md`, st.reply);
        return done('accepted', { rounds: st.round, score: v.score });
      }
      st.feedback = [v.summary, ...v.must_fix.map((x) => '- [обязательно] ' + x), ...v.suggestions.map((x) => '- [желательно] ' + x)].filter(Boolean).join('\n') || 'Улучши результат по критериям приёмки.';
      st.round++; st.phase = 'dev'; save();
    }
    return done('needs_orchestrator', { rounds: maxRounds, note: 'max rounds without acceptance', last_reply_file: `${dir}/round-${maxRounds}.reply.md` });
  } catch (e) {
    done('failed', { error: e.message });
    throw e;
  }
}

// ---------- пакетный прогон ----------
// batch: { id, template:{...поля задачи с {{var}}}, items:[{...vars}], assignees:[...], reviewers:[...], max_parallel }
export async function runBatch(project, agents, batch, { resume = false } = {}) {
  const ids = batch.items.map((it, i) => {
    const id = `${batch.id}-${String(i + 1).padStart(3, '0')}`;
    if (!project.exists('tasks', id + '.json')) {
      project.saveTask({ ...deepRender(batch.template, it), id, status: 'todo', assignee: '', reviewer: '' });
    }
    return id;
  });
  const busy = new Set();
  const queue = ids.filter((id) => project.task(id).status !== 'accepted');
  const results = [];
  const pickPair = () => {
    for (const a of batch.assignees) {
      if (busy.has(a)) continue;
      const r = (batch.reviewers || []).find((x) => x !== a && !busy.has(x));
      if (r || !(batch.reviewers || []).length) return [a, r];
    }
    return null;
  };
  const workers = [];
  const maxPar = batch.max_parallel ?? Math.max(1, Math.floor(batch.assignees.length));
  async function worker() {
    while (queue.length) {
      const pair = pickPair();
      if (!pair) { await sleep(500); continue; }
      const id = queue.shift();
      const [a, r] = pair;
      busy.add(a); if (r) busy.add(r);
      const t = project.task(id); t.assignee = a; t.reviewer = r || ''; project.saveTask(t);
      try { results.push(await runTask(project, agents, id, { resume })); }
      catch (e) { results.push({ id, status: 'failed', error: e.message }); }
      finally { busy.delete(a); if (r) busy.delete(r); }
    }
  }
  for (let i = 0; i < maxPar; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ---------- отчёт и релиз ----------
export function report(project) {
  const rows = project.taskIds().map((id) => project.task(id));
  const per = {};
  for (const t of rows) {
    for (const [role, n] of [['assignee', t.assignee], ['reviewer', t.reviewer]]) { if (!n) continue; per[n] ??= { tasks: 0, accepted: 0, rounds: 0, score: 0, scored: 0 }; if (role === 'assignee') { per[n].tasks++; if (t.status === 'accepted') { per[n].accepted++; per[n].rounds += t.rounds || 0; per[n].score += t.score || 0; per[n].scored++; } } }
  }
  const lines = ['# Отчёт', '', '| Задача | Название | Исполнитель | Рецензент | Статус | Раунды | Оценка |', '|---|---|---|---|---|---|---|'];
  for (const t of rows) lines.push(`| ${t.id} | ${String(t.title || '').replace(/\|/g, '/')} | ${t.assignee || ''} | ${t.reviewer || ''} | ${t.status} | ${t.rounds ?? ''} | ${t.score ?? ''} |`);
  lines.push('', '## Агенты (как исполнители)', '', '| Агент | Задач | Принято | Ср. раундов | Ср. оценка |', '|---|---|---|---|---|');
  for (const [n, s] of Object.entries(per)) lines.push(`| ${n} | ${s.tasks} | ${s.accepted} | ${s.scored ? (s.rounds / s.scored).toFixed(1) : '-'} | ${s.scored ? (s.score / s.scored).toFixed(1) : '-'} |`);
  return lines.join('\n') + '\n';
}

const safeRel = (p) => {
  const n = path.posix.normalize(p.replaceAll('\\', '/').trim());
  if (!n || n.startsWith('/') || n.startsWith('../') || n === '..' || /^[A-Za-z]:/.test(n) || /[\0-\x1f]/.test(n)) throw Error('Unsafe file path in agent output: ' + p);
  return n;
};
export function extractFiles(text) {
  const out = [];
  for (const m of text.matchAll(/^=== FILE: (.+?) ===\r?\n([\s\S]*?)\r?\n=== END FILE ===/gm)) out.push({ path: safeRel(m[1]), content: m[2] + '\n' });
  return out;
}
export function release(project, { name = 'release', tasks } = {}) {
  const ids = tasks || project.taskIds().filter((id) => project.task(id).status === 'accepted');
  const owner = new Map();
  const manifest = [];
  const outDir = `release/${name}`;
  fs.rmSync(project.p(outDir), { recursive: true, force: true });
  for (const id of ids) {
    const t = project.task(id);
    if (t.status !== 'accepted') throw Error(`Task ${id} is not accepted (status: ${t.status})`);
    const body = project.read(`accepted/${id}.md`, 5_000_000);
    const files = t.output_files ? extractFiles(body) : [{ path: safeRel(t.output_path || `${id}.md`), content: body }];
    if (t.output_files && !files.length) throw Error(`Task ${id}: no === FILE: ... === blocks found in accepted output`);
    for (const f of files) {
      if (owner.has(f.path)) throw Error(`File collision: ${f.path} produced by ${owner.get(f.path)} and ${id}`);
      owner.set(f.path, id);
      project.write(`${outDir}/${f.path}`, f.content);
      manifest.push({ path: f.path, task: id, score: t.score, rounds: t.rounds });
    }
  }
  project.saveJson(`${outDir}/MANIFEST.json`, { created: new Date().toISOString(), files: manifest });
  project.write(`${outDir}/REPORT.md`, report(project));
  return { dir: project.p(outDir), files: manifest.length };
}

export function initProject(dir) {
  const src = path.join(HERE, 'template');
  const copy = (s, d) => { fs.mkdirSync(d, { recursive: true }); for (const e of fs.readdirSync(s, { withFileTypes: true })) { const sp = path.join(s, e.name), dp = path.join(d, e.name); if (e.isDirectory()) copy(sp, dp); else if (!fs.existsSync(dp)) fs.copyFileSync(sp, dp); } };
  copy(src, dir);
  for (const d of ['tasks', 'runs', 'accepted', 'release']) fs.mkdirSync(path.join(dir, d), { recursive: true });
}
