// Explicit provider bootstrap context authorization. No DOM or network.
const MARKERS=Object.freeze({
  CLAUDE_NEW_CHAT:Object.freeze({agent:'claude',origin:'https://claude.ai'}),
  GEMINI_NEW_CHAT:Object.freeze({agent:'gemini',origin:'https://gemini.google.com'})
});
export function requireValidBootstrapContext(context,name) {
  const id=context?.conversationId;
  const marker=typeof id==='string' && Object.hasOwn(MARKERS,id) ? MARKERS[id] : null;
  if(Boolean(marker)!==(context?.bootstrap===true) ||
     (marker && (marker.agent!==name || marker.origin!==context.origin)))
    throw Error('SEND_BOOTSTRAP_CONTEXT_INVALID');
  if(context?.bootstrap!==true && context?.bootstrap!==false &&
     context?.bootstrap!==undefined)
    throw Error('SEND_BOOTSTRAP_CONTEXT_INVALID');
  return Object.freeze({bootstrap:!!marker,
    provider:name,origin:context?.origin});
}
