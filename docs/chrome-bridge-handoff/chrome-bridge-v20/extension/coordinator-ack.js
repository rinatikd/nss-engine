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
