// Shared decision function for the background Control UI.
// This only controls UI eligibility; the coordinator is authoritative for grants.
export function backgroundControlUiState({backgroundMode=false,connected=false,mutationEnabled=false,activeCount=0,grantsKnown=true}={}) {
  const revokeAllDisabled=!backgroundMode || !grantsKnown || activeCount===0;
  if (!backgroundMode) return {grantAllDisabled:true,revokeAllDisabled,reason:'Сначала включите фоновый режим'};
  if (!grantsKnown) return {grantAllDisabled:true,revokeAllDisabled,reason:'Не удалось проверить временные разрешения Control'};
  if (activeCount>0) return {grantAllDisabled:true,revokeAllDisabled:false,reason:'Действует временное управление для '+activeCount+' вкладок. Для повторного подключения сначала отзовите разрешения.'};
  if (!connected) return {grantAllDisabled:true,revokeAllDisabled,reason:'Сначала подключите фоновый мост'};
  if (!mutationEnabled) return {grantAllDisabled:true,revokeAllDisabled,reason:'Сначала включите экспериментальное управление'};
  return {grantAllDisabled:false,revokeAllDisabled,reason:'Управление отключено. Можно подключить разрешённые вкладки; каждое действие подтверждается отдельно.'};
}

export function backgroundRevokeErrorMessage(result) {
  const code=typeof result?.error==='string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(result.error)
    ? result.error : 'REVOKE_FAILED';
  const outcome=result?.outcome==='UNKNOWN' ? 'UNKNOWN: ' : '';
  const tabs=Array.isArray(result?.quarantinedTabs)
    ? [...new Set(result.quarantinedTabs.filter(id=>Number.isSafeInteger(id)&&id>0))]
    : [];
  return outcome+code+(tabs.length ? '; карантин вкладок: '+tabs.join(', ') : '');
}
