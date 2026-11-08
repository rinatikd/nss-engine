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
