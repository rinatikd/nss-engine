import { createOneClickSession } from './one-click-session.js';
import { loadBrowserKey } from './browser-key-store.js';

const $ = id => document.getElementById(id);
const session = createOneClickSession(chrome, {
  loadKey: loadBrowserKey,
  start: () => chrome.runtime.sendMessage({target:'bridge-coordinator',type:'start-background'}),
  stop: async () => {
    const r = await chrome.runtime.sendMessage({target:'bridge-coordinator',type:'stop-background'});
    if (!r?.ok) throw Error(r?.reason || 'STOP_FAILED');
  },
  getStatus: () => chrome.runtime.sendMessage({target:'bridge-coordinator',type:'status'})
});
let busy = false;
async function refresh() {
  if (busy) return;
  try {
    const s = await session.status();
    $('status').textContent = s.connected ? 'Подключено' :
      s.state === 'connecting' ? 'Подключение…' : 'Отключено';
    $('detail').textContent = s.error || '';
  } catch {
    $('status').textContent = 'Нет связи с расширением';
  }
}
$('connect').addEventListener('click', async e => {
  if (!e.isTrusted || busy) return;
  busy=true;
  $('connect').disabled=true;
  $('disconnect').disabled=true;
  $('status').textContent='Подключение…';
  // This function must be invoked from the trusted click handler: Chrome can
  // then show its one-time host permission prompt.
  try {
    const result = await session.connect({trustedGesture:e.isTrusted});
    $('status').textContent = result.connected ? 'Подключено' : 'Ожидание подтверждения сервера…';
    $('detail').textContent='';
  } catch(err) {
    $('status').textContent='Не подключено';
    $('detail').textContent=err.message==='PAIRING_REQUIRED'
      ? 'Локальный ключ ещё не привязан. Требуется безопасная первичная настройка Bridge.'
      : err.message;
  } finally {
    busy=false;
    $('connect').disabled=false;
    $('disconnect').disabled=false;
  }
});
$('disconnect').addEventListener('click',async e=>{
  if (!e.isTrusted || busy) return;
  busy=true;
  $('connect').disabled=true;
  $('disconnect').disabled=true;
  try {
    await session.disconnect();
    $('status').textContent='Отключено';
    $('detail').textContent='';
  } catch(err) {
    $('status').textContent='Отключение не подтверждено';
    $('detail').textContent=err.message;
  } finally {
    busy=false;
    $('connect').disabled=false;
    $('disconnect').disabled=false;
  }
});
void refresh();
setInterval(refresh,3000);
