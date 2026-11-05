// Coordinator acknowledgements are untrusted cross-context results.
// Missing / malformed replies must never be treated as successful transitions.
export function requireCoordinatorAck(reply, operation) {
  if (!reply || typeof reply !== 'object' || reply.ok !== true) {
    const reason = reply && typeof reply === 'object' && typeof reply.reason === 'string'
      ? reply.reason
      : 'NO_COORDINATOR_ACK';
    throw Error(operation + ':' + reason);
  }
  return reply;
}

export async function requestCoordinatorAck(send, operation, {
  timeoutMs=8000, schedule=setTimeout, cancel=clearTimeout
}={}) {
  if (typeof send!=='function' || !Number.isFinite(timeoutMs) || timeoutMs<=0)
    throw Error(operation+':INVALID_ACK_REQUEST');
  let timer;
  try {
    const reply = await Promise.race([
      Promise.resolve().then(send),
      new Promise((_,reject)=>{
        timer=schedule(()=>reject(Error(operation+':ACK_TIMEOUT')),timeoutMs);
      })
    ]);
    return requireCoordinatorAck(reply,operation);
  } finally {
    if (timer!==undefined) cancel(timer);
  }
}
