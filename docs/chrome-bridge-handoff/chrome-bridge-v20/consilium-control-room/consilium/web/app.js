let bearer = '';
let lastSeq = 0;
let refreshHandle = null;
let currentActor = null;
const pendingRequestIds = new Map();
const $ = id => document.getElementById(id);
const actorLabels = { owner:'Владелец', chatgpt:'ChatGPT · со-оператор', claude:'Claude · со-оператор', deepseek:'DeepSeek', qwen:'Qwen', kimi:'Kimi', grok:'Grok', gemini:'Gemini' };
function syncPermissions(){
  const canOperate=currentActor?.role==='operator'||currentActor?.role==='owner';
  for(const id of ['start','pause','resume','stop'])$(id).disabled=!canOperate;
  $('propose-round').disabled=!['operator','participant'].includes(currentActor?.role);
}
function toast(message){const el=$('toast');el.textContent=message;el.style.display='block';setTimeout(()=>{el.style.display='none'},3500)}
async function api(path, body){
  const options={method:body?'POST':'GET',headers:{Authorization:`Bearer ${bearer}`} };
  let pendingKey=null;
  if(body){
    const actor=currentActor?.id||'unbound';
    const stableBody={...body};delete stableBody.requestId;
    pendingKey=`${actor}:${path}:${JSON.stringify(stableBody)}`;
    const requestId=body.requestId||pendingRequestIds.get(pendingKey)||crypto.randomUUID();
    pendingRequestIds.set(pendingKey,requestId);
    options.headers['Content-Type']='application/json';options.body=JSON.stringify({...body,requestId});
  }
  const response=await fetch(path,options);
  let result;
  try{result=await response.json()}catch{throw Error('RESPONSE_UNCERTAIN_RETRY_SAME_REQUEST')}
  if(!response.ok){if(response.status>=400&&response.status<500&&pendingKey)pendingRequestIds.delete(pendingKey);throw Error(result.error||`HTTP_${response.status}`)}
  if(pendingKey)pendingRequestIds.delete(pendingKey);
  return result;
}
function addEvent(event){
  if(event.seq<=lastSeq)return;lastSeq=event.seq;
  const card=document.createElement('article');card.className='event';
  const head=document.createElement('div');head.className='event-head';
  const who=document.createElement('span');who.textContent=actorLabels[event.actor.id]||event.actor.id;
  const when=document.createElement('span');when.textContent=`#${event.seq} · ${new Date(event.at).toLocaleString()}`;
  head.append(who,when);
  const kind=document.createElement('div');kind.className='event-type';kind.textContent=event.type;
  const content=document.createElement('div');content.className='event-body';
  const p=event.payload||{};
  if(event.type==='comment.added')content.textContent=p.text||'';
  else if(event.type==='message.recorded')content.textContent=`${p.provider} · ${p.deliveryStatus}\n${p.text||''}`;
  else content.textContent=JSON.stringify(p,null,2);
  card.append(head,kind,content);$('timeline').append(card);
}
function renderDecisions(items){
  const box=$('decisions');box.replaceChildren();
  const taskDecision=$('task-decision');if(taskDecision){taskDecision.replaceChildren();const empty=document.createElement('option');empty.value='';empty.textContent='Выбери принятое решение';taskDecision.append(empty);for(const d of items.filter(x=>x.status==='ACCEPTED')){const opt=document.createElement('option');opt.value=d.id;opt.textContent=d.title;taskDecision.append(opt)}}
  if(!items.length){box.className='empty';box.textContent='Пока нет предложенных решений.';return}
  box.className='';
  for(const d of items){const item=document.createElement('div');item.className='decision';const title=document.createElement('b');title.textContent=d.title;const meta=document.createElement('span');meta.className='pill '+(d.status==='ACCEPTED'?'success-pill':d.status==='PROPOSED'?'warning-pill':'');meta.textContent=`${d.status} · ${d.proposer}`;const body=document.createElement('p');body.textContent=d.rationale;item.append(title,meta,body);
    const reviews=document.createElement('p');reviews.className='muted';reviews.textContent='Текущие ревью: '+(d.reviews||[]).map(r=>`${r.operator}: ${r.verdict}`).join(' · ')+(d.reviewHistory?.length?` · История заменённых ревью: ${d.reviewHistory.length}`:'');item.append(reviews);
    if(['operator','participant'].includes(currentActor?.role)&&['PROPOSED','UNDER_REVIEW','DISPUTED','NEEDS_EVIDENCE','READY_FOR_OWNER'].includes(d.status)){const prior=(d.reviews||[]).find(r=>r.operator===currentActor.id);const actions=document.createElement('div');actions.className='review-actions';for(const verdict of ['SUPPORT','OBJECT','NEEDS_EVIDENCE']){const btn=document.createElement('button');btn.className='secondary';btn.textContent=prior?`Изменить на ${verdict}`:verdict;btn.onclick=async()=>{const rationale=prompt('Обоснование ревью');if(!rationale)return;try{await api('/api/decisions/review',{decisionId:d.id,verdict,rationale,revisionOf:prior?.eventId||undefined});await refresh()}catch(e){toast(e.message)}};actions.append(btn)}item.append(actions)}
    if(currentActor?.role==='owner'&&d.status==='READY_FOR_OWNER'){const accept=document.createElement('button');accept.textContent='Утвердить';accept.onclick=async()=>{try{await api('/api/decisions/approve',{decisionId:d.id});await refresh()}catch(e){toast(e.message)}};item.append(accept)}
    box.append(item)}
}
function renderRounds(items){
  const box=$('rounds');box.replaceChildren();
  if(!items.length){box.className='timeline empty';box.textContent='Раундов пока нет.';return}
  box.className='timeline';
  for(const round of items){
    const row=document.createElement('article');row.className='event';
    const title=document.createElement('b');title.textContent=round.objective;
    const meta=document.createElement('p');meta.className='muted';meta.textContent=`${round.id} · ${round.status} · предложил: ${actorLabels[round.proposedBy]||round.proposedBy}${round.startedBy?' · запустил: '+(actorLabels[round.startedBy]||round.startedBy):''}`;
    row.append(title,meta);
    if(currentActor?.role==='operator'&&round.status==='PROPOSED'){
      const launch=document.createElement('button');launch.textContent='Запустить раунд';
      launch.onclick=async()=>{try{await api('/api/rounds/start',{roundId:round.id});await refresh()}catch(e){toast(e.message)}};
      row.append(launch);
    }
    box.append(row);
  }
}
function renderTasks(items){const box=$('tasks');box.replaceChildren();if(!items.length){box.className='empty';box.textContent='Пока нет задач.';return}box.className='';for(const task of items){const row=document.createElement('div');row.className='task-row';const info=document.createElement('div');const title=document.createElement('b');title.textContent=task.title;const meta=document.createElement('p');meta.className='muted';meta.textContent=`${task.id} · ${task.assignee} · ${task.status} · decision ${task.decisionId}`;info.append(title,meta);row.append(info);if(task.commitSha){const sha=document.createElement('code');sha.textContent=task.commitSha;row.append(sha)}box.append(row)}}
async function refresh(){
  if(!bearer)return;
  try{const data=await api(`/api/snapshot?after=${lastSeq}`);currentActor=data.actor;$('session-status').textContent=data.state.session.status;$('session-title').textContent=data.state.session.title||'Сессия не запущена';renderDecisions(data.state.decisions);renderTasks(data.state.tasks);renderRounds(data.state.rounds||[]);syncPermissions();
    if(lastSeq===0&&data.events.length===0)$('timeline').innerHTML='<div class="empty">Журнал пока пуст.</div>';
    for(const event of data.events)addEvent(event);
  }catch(e){toast(`Ошибка обновления: ${e.message}`)}
}
$('connect').onclick=async()=>{bearer=$('token').value.trim();try{const data=await api('/api/snapshot');currentActor=data.actor;$('identity').textContent=`Подключены как ${actorLabels[currentActor.id]||currentActor.id}.`; $('session-status').textContent=data.state.session.status;$('token').value='';lastSeq=0;$('timeline').replaceChildren();renderDecisions(data.state.decisions);renderTasks(data.state.tasks);renderRounds(data.state.rounds||[]);syncPermissions();for(const event of data.events)addEvent(event);if(refreshHandle)clearInterval(refreshHandle);refreshHandle=setInterval(refresh,2500)}catch(e){bearer='';currentActor=null;toast(`Не удалось подключиться: ${e.message}`)}};
$('start').onclick=async()=>{const title=prompt('Название сессии');if(!title)return;try{await api('/api/session/start',{title});await refresh()}catch(e){toast(e.message)}};
$('pause').onclick=async()=>{try{await api('/api/session/pause',{});await refresh()}catch(e){toast(e.message)}};
$('resume').onclick=async()=>{try{await api('/api/session/resume',{});await refresh()}catch(e){toast(e.message)}};
$('stop').onclick=async()=>{if(!confirm('Запросить остановку сессии? Новые задания будут заблокированы.'))return;try{await api('/api/session/stop',{});await refresh()}catch(e){toast(e.message)}};
$('propose-round').onclick=async()=>{
  const objective=$('round-objective').value.trim();
  const participants=$('round-participants').value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(!objective)return toast('Укажи цель раунда.');
  if(!participants.length||participants.length>7||new Set(participants).size!==participants.length)return toast('Укажи от 1 до 7 уникальных участников.');
  try{await api('/api/rounds/propose',{roundId:crypto.randomUUID(),objective,participants});$('round-objective').value='';await refresh()}catch(e){toast(e.message)}
};
$('send-comment').onclick=async()=>{const value=$('comment').value.trim();if(!value)return;try{await api('/api/comments',{text:value});$('comment').value='';await refresh()}catch(e){toast(e.message)}};
$('propose-decision').onclick=async()=>{const title=$('decision-title').value.trim(),rationale=$('decision-rationale').value.trim();if(!title||!rationale)return toast('Заполни название и обоснование решения.');try{await api('/api/decisions',{title,rationale,risk:$('decision-risk').value,evidence:[]});$('decision-title').value='';$('decision-rationale').value='';await refresh()}catch(e){toast(e.message)}};

$('create-task').onclick=async()=>{const decisionId=$('task-decision').value,title=$('task-title').value.trim(),assignee=$('task-assignee').value;if(!decisionId||!title)return toast('Выбери принятое решение и укажи задачу.');try{await api('/api/tasks',{taskId:crypto.randomUUID(),decisionId,title,assignee});$('task-title').value='';await refresh()}catch(e){toast(e.message)}};

$('disconnect').onclick=()=>{bearer='';currentActor=null;if(refreshHandle)clearInterval(refreshHandle);refreshHandle=null;lastSeq=0;$('identity').textContent='Отключено.';$('session-status').textContent='НЕ ПОДКЛЮЧЕНО';$('session-title').textContent='Сессия скрыта до следующего подключения.';$('timeline').replaceChildren();renderDecisions([]);renderTasks([]);renderRounds([]);syncPermissions();toast('Локальная сессия просмотра отключена.')};

$('export-events').onclick=async()=>{
  try{
    const response=await fetch('/api/export',{headers:{Authorization:`Bearer ${bearer}`}});
    if(!response.ok)throw Error((await response.json()).error||`HTTP_${response.status}`);
    const blob=await response.blob();
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download='consilium-events.ndjson';
    document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);
    toast('Полный журнал экспортирован.');
  }catch(e){toast(`Экспорт не выполнен: ${e.message}`)}
};
