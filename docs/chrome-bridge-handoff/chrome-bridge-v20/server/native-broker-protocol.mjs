// IPC v1.6 protocol validator for a future trusted native broker.
// This is not a containment attestation and does not launch any process.
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_FRAME = 65536;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysExactly = (v, keys) => Object.keys(v).length === keys.length && keys.every(k => hasOwn(v, k));
export function encodeBrokerFrame(value) {
  if (!record(value)) throw Error('IPC_INVALID_FRAME');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME) throw Error('IPC_FRAME_TOO_LARGE');
  return encoded + '\n';
}
export function decodeBrokerFrame(raw, expectedRequestId) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_FRAME ||
      raw.includes('\r') || raw.includes('\n') || raw.includes('\0')) throw Error('IPC_INVALID_FRAME');
  if (!ID.test(expectedRequestId)) throw Error('IPC_INVALID_REQUEST_ID');
  let value;
  try { value = JSON.parse(raw); } catch { throw Error('IPC_INVALID_JSON'); }
  if (!record(value) || !ID.test(value.requestId) || value.requestId !== expectedRequestId) throw Error('IPC_REQUEST_MISMATCH');
  if (value.type === 'ready') {
    if (!keysExactly(value, ['type','requestId','pid','contained']) ||
        !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.contained !== true)
      throw Error('IPC_INVALID_READY');
  } else if (value.type === 'terminated') {
    if (!keysExactly(value, ['type','requestId','verified','activeProcesses']) ||
        value.verified !== true || value.activeProcesses !== 0)
      throw Error('IPC_INVALID_TERMINATED');
  } else throw Error('IPC_UNEXPECTED_TYPE');
  // A well-formed claim is not evidence of OS containment.
  return Object.freeze(value);
}
export function createBrokerFrameDecoder(expectedRequestId) {
  if (!ID.test(expectedRequestId)) throw Error('IPC_INVALID_REQUEST_ID');
  let buffer = Buffer.alloc(0);
  let finished = false;
  return {
    push(chunk) {
      if (finished) throw Error('IPC_STREAM_FINISHED');
      if (!Buffer.isBuffer(chunk)) throw Error('IPC_INVALID_CHUNK');
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME + 1) throw Error('IPC_FRAME_TOO_LARGE');
      const at = buffer.indexOf(10);
      if (at === -1) return null;
      if (buffer.indexOf(10, at + 1) !== -1 || at !== buffer.length - 1) throw Error('IPC_TRAILING_DATA');
      const frame = buffer.subarray(0, at);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(frame);
      finished = true;
      return decodeBrokerFrame(decoded, expectedRequestId);
    },
    end() {
      if (!finished) throw Error('IPC_INCOMPLETE_FRAME');
    },
  };
}
