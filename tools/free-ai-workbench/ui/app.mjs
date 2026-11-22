import {projectLedger} from './viewer.mjs';

const $=id=>document.getElementById(id);
const fileInput=$('ledgerFile');
const search=$('search');
const stateFilter=$('stateFilter');
const integrity=$('integrity');
const taskList=$('taskList');
const empty=$('empty');
const error=$('error');
let loadedTasks=[];

const labels={
 QUEUED:'В очереди',ASSIGNED:'Назначено',IN_REVIEW:'На проверке',
 ACCEPTED:'Принято',REJECTED:'Отклонено'
};
const actionLabels={create:'Создана',assign:'Назначена',submit:'Отправлена на проверку',accept:'Принята',reject:'Отклонена'};

function el(tag,className,text){
 const node=document.createElement(tag);
 if(className)node.className=className;
 if(text!==undefined)node.textContent=String(text);
 return node;
}
function setCount(id,value){$(id).textContent=String(value);}
function renderStats(tasks){
 setCount('statTotal',tasks.length);
 setCount('statActive',tasks.filter(t=>t.state==='QUEUED'||t.state==='ASSIGNED').length);
 setCount('statReview',tasks.filter(t=>t.state==='IN_REVIEW').length);
 setCount('statAccepted',tasks.filter(t=>t.state==='ACCEPTED').length);
 setCount('statRejected',tasks.filter(t=>t.state==='REJECTED').length);
}
function historyText(event){
 const action=actionLabels[event.action]||event.action||'Событие';
 const actor=event.actor||'неизвестно';
 const time=event.recordedAt||event.timestamp||'время не указано';
 const detail=event.comment||event.evidence||event.owner||'';
 return [time,action,'·',actor,detail].filter(Boolean).join(' ');
}
function buildTask(task){
 const card=el('article','task');
 const head=el('div','task-head');
 const left=el('div','task-title');
 left.append(el('h3','',task.title||'Без названия'));
 left.append(el('div','task-id',task.id));
 left.append(el('div','project',task.project||'Проект не указан'));
 const state=el('span','state',labels[task.state]||task.state);
 state.dataset.state=task.state;
 head.append(left,state);
 card.append(head);

 const meta=el('div','task-meta');
 meta.append(el('span','',task.owner?'Исполнитель: '+task.owner:'Не назначена'));
 meta.append(el('span','',task.submittedBy?'Отправил: '+task.submittedBy:'Нет отправки на проверку'));
 meta.append(el('span','',task.reviewedBy?'Проверил: '+task.reviewedBy:'Нет решения проверяющего'));
 card.append(meta);

 const details=el('details');
 details.append(el('summary','','История · '+(task.history||[]).length));
 const list=el('ol','history');
 for(const event of task.history||[])list.append(el('li','',historyText(event)));
 details.append(list);
 card.append(details);
 return card;
}
function renderTasks(){
 const query=(search.value||'').trim().toLowerCase();
 const state=stateFilter.value;
 const filtered=loadedTasks.filter(task=>{
  const matchesState=state==='ALL'||task.state===state;
  const haystack=[task.id,task.title,task.project,task.owner,task.submittedBy,task.reviewedBy].join(' ').toLowerCase();
  return matchesState&&(!query||haystack.includes(query));
 });
 taskList.replaceChildren();
 for(const task of filtered)taskList.append(buildTask(task));
 empty.hidden=filtered.length>0;
 empty.textContent=loadedTasks.length===0?'В журнале нет задач.':'По заданным фильтрам задач не найдено.';
}
function showError(message){
 error.hidden=!message;
 error.textContent=message||'';
}
function resetView(){
 loadedTasks=[];
 taskList.replaceChildren();
 empty.hidden=false;
 empty.textContent='Нет загруженного журнала.';
 renderStats([]);
 $('eventSummary').textContent='Загрузи журнал, чтобы увидеть его содержимое.';
 integrity.textContent='Журнал не загружен';
 integrity.dataset.state='empty';
 search.disabled=true;
 stateFilter.disabled=true;
 search.value='';
 stateFilter.value='ALL';
}
fileInput.addEventListener('change',async()=>{
 const file=fileInput.files?.[0];
 if(!file)return;
 showError('');
 try{
  if(file.size>4*1024*1024)throw Error('LEDGER_TOO_LARGE');
  const raw=await file.text();
  const result=await projectLedger(raw);
  loadedTasks=result.tasks;
  integrity.textContent=result.integrity==='V2_CHAIN_VERIFIED'
   ?'SHA-256 цепочка проверена'
   :'Legacy журнал без hash-chain';
  integrity.dataset.state=result.integrity==='V2_CHAIN_VERIFIED'?'verified':'legacy';
  $('fileMeta').textContent=file.name+' · '+file.size.toLocaleString('ru-RU')+' байт';
  $('eventSummary').textContent=
   result.eventCount+' событий · '+result.legacyEventCount+' legacy · '+result.v2EventCount+' V2 · requestId: '+result.requestCount;
  renderStats(loadedTasks);
  search.disabled=false;
  stateFilter.disabled=false;
  renderTasks();
 }catch(e){
  resetView();
  $('fileMeta').textContent=file.name+' · файл не принят';
  integrity.textContent='Ошибка проверки журнала';
  integrity.dataset.state='error';
  showError('Журнал не показан: '+(e?.message||'LEDGER_INVALID'));
 }
});
search.addEventListener('input',renderTasks);
stateFilter.addEventListener('change',renderTasks);
resetView();
