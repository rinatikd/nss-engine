// Pure reconciliation planner for a post-reboot Windows stack. No process starts here.
// An endpoint answering HTTP 404/405 is NOT equivalent to an authenticated healthy service.
// All ownership/process IDs are checked by the host's independently trusted probe.
export const STACK_IDS=Object.freeze([
  'chrome-prod-server','chrome-prod-mcp','chrome-rc1-lab',
  'chrome-pr102-lab','powershell-direct','powershell-direct-tunnel',
  'chrome-pr102-tunnel'
]);
export const STATES=Object.freeze(['healthy','stopped','occupied','unhealthy','unknown']);
export function validateRecoveryProfile(profile){
  if(!profile||typeof profile!=='object'||!Array.isArray(profile.services))
    throw Error('INVALID_RECOVERY_PROFILE');
  const seen=new Set();
  for(const s of profile.services){
    if(!s||typeof s!=='object'||!STACK_IDS.includes(s.id)||seen.has(s.id))
      throw Error('INVALID_SERVICE_ID');
    seen.add(s.id);
    if(!Array.isArray(s.after)||s.after.some(x=>!STACK_IDS.includes(x)||x===s.id))
      throw Error('INVALID_DEPENDENCIES');
    if(typeof s.enabled!=='boolean'||typeof s.autoRestore!=='boolean')
      throw Error('INVALID_SERVICE_POLICY');
    if(s.autoRestore&&!s.enabled)throw Error('AUTORESTORE_REQUIRES_ENABLED');
  }
  for(const s of profile.services){
    if(s.after.some(x=>!seen.has(x)))throw Error('MISSING_DEPENDENCY');
  }
  const visiting=new Set(),visited=new Set();
  const visit=id=>{
    if(visiting.has(id))throw Error('CYCLIC_DEPENDENCIES');
    if(visited.has(id))return;
    visiting.add(id);
    const s=profile.services.find(x=>x.id===id);
    for(const dep of s.after)visit(dep);
    visiting.delete(id);visited.add(id);
  };
  for(const s of profile.services)visit(s.id);
  return profile;
}
export function recoveryPlan(profile, observations, {requested=false}={}){
  validateRecoveryProfile(profile);
  const order=[], visited=new Set();
  const byId=Object.fromEntries(profile.services.map(x=>[x.id,x]));
  function visit(id){
    if(visited.has(id))return;
    for(const dep of byId[id].after)visit(dep);
    visited.add(id);order.push(id);
  }
  for(const s of profile.services)visit(s.id);
  const outcomes={};
  const actions=[];
  for(const id of order){
    const s=byId[id];
    const obs=observations[id];
    if(!STATES.includes(obs?.state)) {
      outcomes[id]='BLOCKED_NO_TRUSTED_OBSERVATION';continue;
    }
    if(!s.enabled){outcomes[id]='DISABLED';continue;}
    if(s.after.some(dep=>outcomes[dep]!=='ALREADY_HEALTHY'&&outcomes[dep]!=='START_PLANNED')){
      outcomes[id]='BLOCKED_DEPENDENCY';continue;
    }
    if(obs.state==='healthy'){
      outcomes[id]='ALREADY_HEALTHY';continue;
    }
    if(obs.state!=='stopped'){
      outcomes[id]='BLOCKED_'+obs.state.toUpperCase();continue;
    }
    if(!requested||!s.autoRestore){
      outcomes[id]='STOPPED_NOT_AUTHORIZED';continue;
    }
    outcomes[id]='START_PLANNED';actions.push({id,action:'start-once'});
  }
  return {actions,outcomes};
}
