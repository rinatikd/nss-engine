import fs from 'node:fs';
import path from 'node:path';

// Executable configuration is deliberately unsupported until a native trust
// verifier and an OS-confined runner have been deployed and tested. In particular,
// never import a candidate to discover its workspace list or runner.verify().
export async function loadCodexJobs(modulePath) {
  if (typeof modulePath !== 'string' || !path.isAbsolute(modulePath) ||
      modulePath.startsWith('\\\\') || /[\0-\x1f]/.test(modulePath) ||
      modulePath.slice(2).includes(':')) throw Error('INVALID_POLICY_MODULE');
  try {
    const resolved = path.resolve(modulePath);
    let part = path.parse(resolved).root;
    for (const segment of resolved.slice(part.length).split(path.sep).filter(Boolean)) {
      part = path.join(part, segment);
      if (fs.lstatSync(part).isSymbolicLink()) throw Error('POLICY_LINK_DENIED');
    }
    if (!fs.lstatSync(resolved).isFile()) throw Error('INVALID_POLICY_MODULE');
    const canonical = fs.realpathSync.native(resolved);
    const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!equal(canonical, resolved)) throw Error('POLICY_LINK_DENIED');
  } catch (error) {
    if (['POLICY_LINK_DENIED', 'INVALID_POLICY_MODULE'].includes(error.message)) throw error;
    throw Error('INVALID_POLICY_MODULE');
  }
  // Node lstat does not attest every Windows reparse tag, DACL, ancestor
  // replacement permission, hard-link alias or import dependency. No location
  // is trusted on this evidence. Reject ALL candidates without reading/evaluating
  // their contents, including apparently canonical files outside the workspace.
  throw Error('CODEX_ISOLATION_UNAVAILABLE');
}

