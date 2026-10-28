import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace('refresh();setInterval(refresh,1500);', '');
function fixture() {
  const nodes=new Map();
  const get=id=>{
    if(!nodes.has(id))nodes.set(id,{textContent:'',value:'',disabled:false,handlers:{},
      addEventListener(t,fn){this.handlers[t]=fn;},replaceChildren(){},append(){},scrollIntoView(){},
      set innerHTML(_){throw new Error('Untrusted HTML insertion');}});
    return nodes.get(id);
  };
  const pending=[];
  const context=vm.createContext({document:{getElementById:get,querySelector:()=>({content:'test'})},
    fetch:(path,options)=>new Promise(resolve=>pending.push({path,options,resolve:(body,ok=true)=>resolve({ok,json:async()=>body})})),
    crypto:{getRandomValues(bytes){bytes.fill(42);return bytes;}},Date,Set,JSON,encodeURIComponent,Uint8Array});
  vm.runInContext(source,context);
  return {get,pending,run:code=>vm.runInContext(code,context)};
}
const task=id=>({task_id:id,state:'submitted',answer:null,ai_reviewed:false,human_accepted:false});
test('late Codex detail cannot replace current selection',async()=>{
  const f=fixture();const a=f.run("codexSelected='A';showCodexTask()");const b=f.run("codexSelected='B';showCodexTask()");
  f.pending[1].resolve(task('B'));await b;f.pending[0].resolve(task('A'));await a;
  assert.equal(f.get('codex-detail-id').textContent,'B');assert.equal(f.run('codexDetail.task_id'),'B');
});
test('Codex cancellation refuses stale displayed task',async()=>{
  const f=fixture();f.run("renderCodexTask({task_id:'A',state:'submitted'});codexSelected='B'");
  await f.get('codex-cancel').handlers.click();assert.equal(f.pending.length,0);assert.match(f.get('notice').textContent,/Дождитесь/);
});
test('Codex answer is displayed as plain text without review claim',()=>{
  const f=fixture();f.run("renderCodexTask({task_id:'A',state:'completed',answer:'<img src=x onerror=alert(1)>'})");
  assert.equal(f.get('codex-answer').textContent,'<img src=x onerror=alert(1)>');
  assert.match(f.get('codex-task-status').textContent,/рецензия не выполнялась/);assert.equal(f.get('codex-cancel').disabled,true);
});
test('uncertain submit keeps request ID for explicit retry and never resends itself',async()=>{
  const f=fixture();f.run('refresh=async()=>{}');f.get('codex-prompt').value='Synthetic question';
  const first=f.get('codex-form').handlers.submit({preventDefault(){}});
  const original=JSON.parse(f.pending[0].options.body);
  f.pending[0].resolve({error:'Outcome unknown'},false);await first;
  assert.equal(f.pending.length,1);assert.match(f.get('notice').textContent,/Outcome unknown/);
  const retry=f.get('codex-form').handlers.submit({preventDefault(){}});
  assert.deepEqual(JSON.parse(f.pending[1].options.body),original);
  f.pending[1].resolve(task('codex-'+original.request_id));await retry;
  assert.equal(f.pending.length,2);assert.equal(f.run('codexPending'),null);
});

test('missing selected task does not mark a healthy backend unavailable',async()=>{
  const f=fixture();const refresh=f.run("codexSelected='missing';refreshCodex()");
  f.pending[0].resolve({configured:true,available:true});await new Promise(setImmediate);
  f.pending[1].resolve({tasks:[]});await new Promise(setImmediate);
  f.pending[2].resolve({error:'Task not found'},false);await refresh;
  assert.equal(f.run('codexAvailable'),true);assert.equal(f.get('codex-send').disabled,false);
  assert.equal(f.get('codex-detail-id').textContent,'missing');assert.equal(f.get('codex-cancel').disabled,true);
  assert.match(f.get('codex-task-status').textContent,/Task not found/);
});


test('unavailable local model explains why submitted tasks will wait',async()=>{
  const f=fixture();const pending=f.run('refreshCodex()');
  f.pending[0].resolve({configured:true,available:true,local_model_available:false});await new Promise(setImmediate);
  f.pending[1].resolve({tasks:[]});await pending;
  assert.equal(f.run('codexAvailable'),true);
  assert.match(f.get('codex-health-detail').textContent,/модель.*недоступна/i);
  assert.match(f.get('codex-health-detail').textContent,/очереди/);
});
