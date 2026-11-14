import { eligibleWebUrl } from './one-click-session.js';
import { permittedTab } from './read-only-dispatch.js';
import { providerForOrigin } from './permissions.js';
import { DEFAULT_ADAPTERS } from './adapters.js';

async function enabled(api) {
  const s=await api.storage.local.get(['bridgeConnectionDesired','bridgeAllTabsMode']);
  if(s.bridgeConnectionDesired!==true || s.bridgeAllTabsMode!==true)
    throw Error('ALL_TABS_CONTROL_DISABLED');
}
function validatedUrl(raw) {
  if(!eligibleWebUrl(raw)) throw Error('URL_NOT_PERMITTED');
  const url=new URL(raw);
  if(['localhost','127.0.0.1','[::1]'].includes(url.hostname))
    throw Error('LOCAL_URL_DENIED');
  return url;
}
export async function dispatchOneClickNavigation(cmd,api) {
  if(!cmd || !['browser_open','agent_new_chat'].includes(cmd.name) ||
     !Number.isFinite(cmd.expires)||Date.now()>=cmd.expires)
    throw Error('INVALID_OR_EXPIRED_COMMAND');
  await enabled(api);
  if(cmd.name==='browser_open') {
    const u=validatedUrl(cmd.args?.url);
    const t=await api.tabs.create({url:u.href,active:cmd.args?.active===true});
    return {tabId:t.id,url:t.url||u.href};
  }
  const {tab,origin,site}=await permittedTab(api,cmd.args?.tabId);
  const provider=providerForOrigin(origin);
  if(!['claude','gemini','deepseek'].includes(provider) ||
     site.adapter!==provider || site.mode!=='chat')
    throw Error('CHAT_NAVIGATION_DENIED');
  const next=DEFAULT_ADAPTERS[provider]?.newChatUrl;
  if(!next||validatedUrl(next).origin!==origin)
    throw Error('NO_SAME_ORIGIN_NEW_CHAT_URL');
  await enabled(api);
  const current=await permittedTab(api,tab.id);
  if(current.tab.url!==tab.url) throw Error('TAB_CHANGED');
  await api.tabs.update(tab.id,{url:next});
  return {ok:true};
}
