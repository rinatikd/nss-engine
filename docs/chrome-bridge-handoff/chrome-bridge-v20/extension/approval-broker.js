// Pending approvals belong to the coordinator, not to the disposable panel.
// No execution authority is granted by a panel message alone: the executor
// must independently re-check origin, epoch, tab identity, and permissions.
export class ApprovalBroker {
  constructor({now=Date.now, onChange=()=>{}}={}) {
    this.now=now;
    this.onChange=onChange;
    this.pending=new Map();
  }
  request({id,command,origin,tabId,expires}) {
    if (typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(id))
      throw Error('INVALID_APPROVAL_ID');
    if (this.pending.has(id)) throw Error('DUPLICATE_APPROVAL');
    if (!Number.isSafeInteger(tabId) || tabId<=0) throw Error('INVALID_TAB_ID');
    if (typeof origin!=='string' || !origin.startsWith('https://') ||
        new URL(origin).origin!==origin) throw Error('INVALID_ORIGIN');
    if (!Number.isFinite(expires) || expires<=this.now() ||
        expires>this.now()+120000) throw Error('INVALID_APPROVAL_EXPIRY');
    if (!['browser_open','browser_click','browser_fill','agent_send','agent_new_chat'].includes(command))
      throw Error('COMMAND_NOT_APPROVABLE');
    const item={id,command,origin,tabId,expires,status:'pending'};
    this.pending.set(id,item);
    this.onChange(this.list());
    return {...item};
  }
  list() {
    this.expire();
    return [...this.pending.values()].map(item=>({...item}));
  }
  expire() {
    for(const [id,p] of this.pending)
      if(p.expires<=this.now()) this.pending.delete(id);
  }
  decide({id,approved,trustedUserGesture}) {
    this.expire();
    const item=this.pending.get(id);
    if(!item) throw Error('APPROVAL_NOT_FOUND_OR_EXPIRED');
    if(trustedUserGesture!==true) throw Error('USER_GESTURE_REQUIRED');
    this.pending.delete(id);
    this.onChange(this.list());
    return {...item,approved:approved===true};
  }
  revokeAll() {
    this.pending.clear();
    this.onChange([]);
  }
}
