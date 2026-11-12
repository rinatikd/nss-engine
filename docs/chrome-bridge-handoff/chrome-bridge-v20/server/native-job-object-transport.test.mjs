import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createNativeJobObjectTransport } from './native-job-object-transport.mjs';

function mockSpawn(onCommand) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write(line) {
        const message = JSON.parse(line);
        queueMicrotask(() => onCommand(message, child));
        return true;
      },
      end() {},
    };
    child.kill = () => true;
    return child;
  };
}
const supervisorExe = 'C:\\lab\\supervisor.exe';
const executable = 'C:\\lab\\worker.exe';
const cwd = 'C:\\lab';
const requestId = 'smoke-001';
const launch = { executable, cwd, requestId, args: [] };

test('valid ready and verified termination handshake', async () => {
  const transport = createNativeJobObjectTransport({
    platform: 'win32', supervisorExe,
    spawnProcess: mockSpawn((message, child) => {
      if (message.type === 'launch') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({
          type: 'ready', requestId, pid: 1234, contained: true,
        }) + '\n'));
      } else {
        child.stdout.emit('data', Buffer.from(JSON.stringify({
          type: 'terminated', requestId, verified: true, activeProcesses: 0,
        }) + '\n'));
      }
    }),
  });
  const handle = await transport.launchContained(launch);
  assert.equal(handle.pid, 1234);
  await transport.terminateAndVerify(handle);
});

test('reject uncontained ready and retain duplicate reservation', async () => {
  const transport = createNativeJobObjectTransport({
    platform: 'win32', supervisorExe,
    spawnProcess: mockSpawn((message, child) => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'ready', requestId, pid: 1234, contained: false,
      }) + '\n'));
    }),
  });
  await assert.rejects(transport.launchContained(launch), /SUPERVISOR_NOT_CONTAINED/);
  await assert.rejects(transport.launchContained(launch), /SUPERVISOR_DUPLICATE/);
});

test('reject malformed native JSON', async () => {
  const transport = createNativeJobObjectTransport({
    platform: 'win32', supervisorExe,
    spawnProcess: mockSpawn((message, child) => child.stdout.emit('data', Buffer.from('{bad}\n'))),
  });
  await assert.rejects(transport.launchContained(launch), /SUPERVISOR_INVALID_JSON/);
});

test('reject mismatched request ID', async () => {
  const transport = createNativeJobObjectTransport({
    platform: 'win32', supervisorExe,
    spawnProcess: mockSpawn((message, child) => child.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'ready', requestId: 'wrong', pid: 1, contained: true,
    }) + '\n'))),
  });
  await assert.rejects(transport.launchContained(launch), /SUPERVISOR_INVALID_MESSAGE/);
});

test('reject native supervisor without Windows platform', () => {
  assert.throws(() => createNativeJobObjectTransport({ platform: 'linux', supervisorExe }), /WINDOWS_ONLY/);
});
