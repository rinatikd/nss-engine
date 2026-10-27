import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace('refresh();setInterval(refresh,1500);', '');
function fixture() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent:'', disabled:false, handlers:{},
      addEventListener(type, fn) { this.handlers[type]=fn; }, replaceChildren(){}, scrollIntoView(){}, append(){} });
    return nodes.get(id);
  };
  const pending=[];
  const context = vm.createContext({ document:{getElementById:get,querySelector:()=>({content:'test'})},
    fetch: path=>new Promise(resolve=>pending.push({path,resolve:body=>resolve({ok:true,json:async()=>body})})),
    console, Date, Set, JSON, encodeURIComponent });
  vm.runInContext(source,context);
  return {get,pending,run:code=>vm.runInContext(code,context)};
}
const task = id=>({id,state:'QUEUED',spec:{mode:'local',prompt:id,rubric:'brief'},revision:0,answer:id,attempts:[],events:[]});
test('late detail response cannot replace a newer selected task', async()=>{
  const f=fixture();
  const a=f.run("selected='A';showDetail()");
  const b=f.run("selected='B';showDetail()");
  f.pending[1].resolve(task('B'));await b;
  f.pending[0].resolve(task('A'));await a;
  assert.equal(f.get('detail-title').textContent,'B');
  assert.equal(f.run('detail.id'),'B');
});
test('cancel refuses a stale displayed task while selection is loading', async()=>{
  const f=fixture();
  const a=f.run("selected='A';showDetail()");f.pending[0].resolve(task('A'));await a;
  f.run("selected='B'");
  await f.get('cancel').handlers.click();
  assert.equal(f.pending.length,1,'No cancellation sent for either mismatched task');
  assert.match(f.get('notice').textContent,/Дождитесь/);
});
test('approval recommendations stay visible without being labeled blocking', ()=>{
  const f=fixture();
  const result=f.run("reviewNotes({decision:'APPROVE',blocking_issues:[],recommendations:['Use 86.40']})");
  assert.match(result,/Рекомендации: Use 86.40/);assert.doesNotMatch(result,/Существенные/);
  assert.match(f.run("reviewNotes({decision:'APPROVE',evidence_gaps:['Legacy note']})"),/Рекомендации: Legacy note/);
});
