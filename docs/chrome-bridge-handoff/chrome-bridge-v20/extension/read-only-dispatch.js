// Explicit minimal allowlist: no automation can send prompts, click, fill,
// navigate or grant permissions while the approval UI is not yet migrated.
const MUTATING = new Set(['browser_open','browser_click','browser_fill','agent_send','agent_new_chat']);
export function dispatchReadOnly(command, chromeApi) {
  if (!command || typeof command !== 'object' || typeof command.name !== 'string')
    throw Error('INVALID_COMMAND');
  if (MUTATING.has(command.name)) throw Error('CONTROL_REQUIRES_APPROVAL_UI');
  // First migration slice only supports transport introspection. Data-bearing
  // tab reads stay disabled until the existing origin restrictions are ported.
  if (command.name === 'control_status') {
    return {
      connected: true,
      globalEnabled: false,
      approvalPending: 0,
      origins: []
    };
  }
  throw Error('BACKGROUND_COMMAND_NOT_MIGRATED');
}
