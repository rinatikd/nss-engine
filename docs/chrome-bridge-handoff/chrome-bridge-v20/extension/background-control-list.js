const ALLOWED_ORIGINS=new Set([
  'https://claude.ai','https://gemini.google.com','https://chat.deepseek.com'
]);

// Render only validated per-tab grant metadata. The callback is reached only
// from a browser-trusted local click; the coordinator still revalidates sender,
// tab identity, mutation lane and durable Revoke fences.
export function renderBackgroundControlGrants(container,grants,onRevoke) {
  container.replaceChildren();
  if (!Array.isArray(grants)) {
    const note=document.createElement('p');
    note.className='hint';
    note.textContent='Список разрешений недоступен.';
    container.append(note);
    return;
  }
  let count=0;
  for (const grant of grants) {
    if (!grant || !Number.isSafeInteger(grant.tabId) || grant.tabId<=0 ||
        !ALLOWED_ORIGINS.has(grant.origin) || !Number.isFinite(grant.expiresAt)) continue;
    const row=document.createElement('div');
    row.className='approval';
    const label=document.createElement('p');
    label.textContent=grant.origin+' · вкладка '+grant.tabId+
      ' · до '+new Date(grant.expiresAt).toLocaleTimeString();
    const button=document.createElement('button');
    button.type='button';
    button.className='danger';
    button.textContent='Отозвать разрешение вкладки';
    button.addEventListener('click',event=>{
      if (!event?.isTrusted || typeof onRevoke!=='function') return;
      void onRevoke(grant.tabId,button);
    });
    row.append(label,button);
    container.append(row);
    count++;
  }
  if (!count) {
    const note=document.createElement('p');
    note.className='hint';
    note.textContent='Нет активных разрешений по вкладкам.';
    container.append(note);
  }
}
