// Shared decision function for the background Control UI.
// This only controls UI eligibility; the coordinator is authoritative for grants.
export function backgroundControlUiState({backgroundMode=false,connected=false,mutationEnabled=false}={}) {
  if (!backgroundMode) return {grantAllDisabled:true,reason:'Сначала включите фоновый режим'};
  if (!connected) return {grantAllDisabled:true,reason:'Сначала подключите фоновый мост'};
  if (!mutationEnabled) return {grantAllDisabled:true,reason:'Сначала включите экспериментальное управление'};
  return {grantAllDisabled:false,reason:'Управление доступно только открытым разрешённым вкладкам; каждое действие подтверждается отдельно'};
}
