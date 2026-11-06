// Re-selecting background mode is not an instruction to connect.
// A deliberate Stop persists bridgeConnectionDesired=false. In that state the
// panel must offer a fresh authenticated Connect, not send start-background
// and interpret MANUAL_DISCONNECT as a fatal transition error.
export function backgroundStartupDecision({connectionDesired=false,hasSavedKey=false}={}) {
  return connectionDesired===true && hasSavedKey===true ? 'start' : 'await-connect';
}
