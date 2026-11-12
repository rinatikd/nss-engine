// IPC v1.6: safe, side-effect-free activation diagnostics.
// Never loads a policy module, launches a child or reads credential values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectCodexActivation({ policyPath = process.env.CHROME_BRIDGE_CODEX_POLICY, runtimeFile = fileURLToPath(new URL('./codex-runtime.mjs', import.meta.url)) } = {}) {
  const result = { schema: 1, policyConfigured: Boolean(policyPath), policyPathShape: 'absent',
    runtimeGate: 'unknown', activation: 'disabled', nextAction: 'review-native-broker' };
  if (policyPath) {
    result.policyPathShape = typeof policyPath === 'string' && path.isAbsolute(policyPath) &&
      !policyPath.startsWith('\\\\') && !/[\0-\x1f]/.test(policyPath) && !policyPath.slice(2).includes(':')
      ? 'absolute-local-candidate' : 'invalid';
  }
  // This is a source-code diagnostic, not an attestation of the running process.
  try {
    const source = fs.readFileSync(runtimeFile, 'utf8');
    result.runtimeGate = source.includes("throw Error('CODEX_ISOLATION_UNAVAILABLE')") ?
      'unconditional-reject-in-source' : 'requires-manual-review';
  } catch { result.runtimeGate = 'source-unavailable'; }
  if (result.runtimeGate === 'unconditional-reject-in-source') result.nextAction = 'implement-trusted-native-runner';
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(inspectCodexActivation(), null, 2) + '\n');
}
