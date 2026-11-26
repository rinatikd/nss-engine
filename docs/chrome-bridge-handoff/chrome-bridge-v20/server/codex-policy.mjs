import fs from 'node:fs';
import path from 'node:path';

// This is a deployment boundary, not a substitute for an OS sandbox.
export function createCodexPolicy({ executable, workspaces, runner }) {
  const localPath = (p) => typeof p === 'string' && path.isAbsolute(p) && !p.startsWith('\\\\') && !/[\0-\x1f]/.test(p) && !p.slice(2).includes(':');
  const canonical = (p, directory) => {
    if (!localPath(p)) throw Error('INVALID_POLICY_PATH');
    const resolved = path.resolve(p);
    let part = path.parse(resolved).root;
    for (const segment of resolved.slice(part.length).split(path.sep).filter(Boolean)) {
      part = path.join(part, segment);
      if (fs.lstatSync(part).isSymbolicLink()) throw Error('POLICY_LINK_DENIED');
    }
    if (fs.statSync(resolved).isDirectory() !== directory) throw Error('INVALID_POLICY_PATH');
    return fs.realpathSync(resolved);
  };
  const exe = canonical(executable, false);
  if (process.platform === 'win32' && !exe.toLowerCase().endsWith('.exe')) throw Error('NATIVE_EXECUTABLE_REQUIRED');
  if (!runner || typeof runner.launch !== 'function' || typeof runner.verify !== 'function') throw Error('ISOLATED_RUNNER_REQUIRED');
  const approved = new Map(Object.entries(workspaces || {}).map(([id, dir]) => {
    if (!/^[a-z0-9_-]{1,32}$/.test(id)) throw Error('INVALID_WORKSPACE_ID');
    return [id, canonical(dir, true)];
  }));
  return {
    check(workspace) {
      const cwd = approved.get(workspace);
      if (!cwd) throw Error('WORKSPACE_DENIED');
      if (canonical(cwd, true) !== cwd || canonical(exe, false) !== exe) throw Error('POLICY_PATH_CHANGED');
      // Must attest version, credential isolation, configuration isolation and tree supervision.
      if (runner.verify({ executable: exe, cwd, version: '0.164.0' }) !== true) throw Error('ISOLATION_UNAVAILABLE');
      return cwd;
    },
    launch(workspace) {
      const cwd = this.check(workspace);
      return runner.launch(exe, ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--color', 'never', '--cd', cwd, '-'], {
        cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {},
      });
    },
  };
}

