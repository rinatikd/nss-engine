import { createOneClickSession } from './one-click-session.js';
import { loadBrowserKey, saveBrowserKey } from './browser-key-store.js';
import { verifyBridgeCredential } from './connection-check.js';
import { requestLocalRecovery, formatRecoverySummary } from './recovery-native.js';

const $ = id => document.getElementById(id);
const session = createOneClickSession(chrome, {
  loadKey: async () => {
    const existing = await loadBrowserKey(chrome);
    if (existing.value) return existing;
    const field = $('pairing-key');
    const candidate = field?.value?.trim() || '';
    if (!candidate) {
      $('pairing').hidden = false;
      throw Error('PAIRING_REQUIRED');
    }
    await verifyBridgeCredential(fetch, candidate);
    await saveBrowserKey(chrome, candidate);
    field.value = '';
    $('pairing').hidden = true;
    return { value: candidate, persistent: true };
  },
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
      ? 'Для первой привязки введите локальный browserToken и повторно нажмите «Подключить».'
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
$('recover').addEventListener('click',async e=>{
  if(!e.isTrusted || busy) return;
  busy=true;
  $('recover').disabled=true;
  $('recover-status').textContent='Проверка и восстановление локальных служб…';
  try {
    const result=await requestLocalRecovery(chrome,'restore');
    $('recover-status').textContent=formatRecoverySummary(result);
    await refresh();
  } catch(err) {
    $('recover-status').textContent=
      err.message==='NATIVE_HOST_NOT_INSTALLED_OR_UNAVAILABLE'
        ? 'Локальный Recovery Host ещё не установлен или недоступен. Требуется первоначальная установка на Windows.'
        : 'Восстановление не подтверждено: '+err.message;
  } finally {
    busy=false;
    $('recover').disabled=false;
  }
});
void refresh();
setInterval(refresh,3000);
