// Native Messaging allows the one-click recovery operation even if the
// loopback Bridge server and all tunnel clients are stopped.
// Chrome verifies the manifest's allowed_origins before starting the local
// host; the host accepts exactly one fixed action, never shell or paths.
export const RECOVERY_HOST = 'com.chrome_bridge.recovery';
export function requestLocalRecovery(chromeApi, action = 'restore') {
  if (action !== 'restore' && action !== 'status')
    return Promise.reject(Error('ACTION_NOT_ALLOWED'));
  if (typeof chromeApi?.runtime?.sendNativeMessage !== 'function')
    return Promise.reject(Error('NATIVE_MESSAGING_NOT_AVAILABLE'));
  return new Promise((resolve,reject)=>{
    chromeApi.runtime.sendNativeMessage(RECOVERY_HOST,{action},message=>{
      const err=chromeApi.runtime.lastError;
      if(err) {
        reject(Error('NATIVE_HOST_NOT_INSTALLED_OR_UNAVAILABLE'));
        return;
      }
      if(!message||typeof message!=='object'||message.ok!==true) {
        reject(Error(
          typeof message?.error==='string' &&
          /^[A-Z_]{3,64}$/.test(message.error)
            ? message.error : 'RECOVERY_NOT_CONFIRMED'
        ));
        return;
      }
      resolve({
        ok:true,
        action,
        servers: Array.isArray(message.servers)?message.servers.slice(0,20):[],
        connections: Array.isArray(message.connections)?message.connections.slice(0,20):[]
      });
    });
  });
}
export function formatRecoverySummary(result) {
  const allowed=/^[A-Za-z0-9_-]{1,80}$/;
  const safe=s=>typeof s==='string'&&allowed.test(s)?s:'UNKNOWN';
  const parts=[...result.servers,...result.connections]
    .filter(x=>x&&typeof x==='object')
    .map(x=>safe(x.id)+': '+safe(x.state));
  return (parts.length?parts.join(' | '):'Нет подтверждённых состояний')+
    '. Подключение MCP необходимо проверить отдельно.';
}
