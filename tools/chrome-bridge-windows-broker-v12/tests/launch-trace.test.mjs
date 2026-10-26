import test from 'node:test';
import assert from 'node:assert/strict';
import { successfulLaunchFixture, validateLaunchTrace } from '../launch-trace.mjs';

test('synthetic success trace places ResumeThread after image, token, Job and handle checks', () => {
  assert.deepEqual(validateLaunchTrace(successfulLaunchFixture), {
    protocolShapeValid: true, nativeCallsObserved: false, osIsolationProven: false, executionAuthorized: false,
  });
});

test('resume before verified image identity, AppContainer, Job or explicit handle list is rejected', () => {
  const events = [...successfulLaunchFixture];
  events.splice(events.indexOf('childImageFileIdAndHashMatched'), 1);
  assert.throws(() => validateLaunchTrace(events), /LAUNCH_RESUME_ORDER_INVALID/);
  const withoutJob = [...successfulLaunchFixture];
  withoutJob.splice(withoutJob.indexOf('jobAssignedWithBreakawayDisabled'), 1);
  assert.throws(() => validateLaunchTrace(withoutJob), /LAUNCH_RESUME_ORDER_INVALID/);
});

test('failed suspended image identity rolls back and never resumes or falls back', () => {
  const trace = [
    'candidateHandleOpened', 'hashSignerAclPinsVerified', 'createProcessSuspended',
    'imageIdentityMismatch', 'rollbackStarted', 'terminateChild', 'waitChildExit', 'closeJob', 'closeHandles', 'launchDenied',
  ];
  assert.equal(validateLaunchTrace(trace).executionAuthorized, false);
  assert.throws(() => validateLaunchTrace([...trace, 'fallbackLaunch']), /LAUNCH_TRACE_FORBIDDEN_EVENT/);
});

test('Job Object assignment failure terminates and waits before closing handles', () => {
  const trace = [
    'candidateHandleOpened', 'hashSignerAclPinsVerified', 'createProcessSuspended',
    'childImageFileIdAndHashMatched', 'appContainerTokenAndCapabilitiesMatched', 'jobAssignmentFailed',
    'rollbackStarted', 'terminateChild', 'waitChildExit', 'closeJob', 'closeHandles', 'launchDenied',
  ];
  assert.equal(validateLaunchTrace(trace).nativeCallsObserved, false);
  const unordered = [...trace];
  const terminateAt = unordered.indexOf('terminateChild');
  const waitAt = unordered.indexOf('waitChildExit');
  [unordered[terminateAt], unordered[waitAt]] = [unordered[waitAt], unordered[terminateAt]];
  assert.throws(() => validateLaunchTrace(unordered), /LAUNCH_ROLLBACK_ORDER_INVALID/);
});

test('pre-create failure closes all opened handles and remains denied', () => {
  const trace = ['candidateHandleOpened', 'pinMismatch', 'rollbackStarted', 'closeHandles', 'launchDenied'];
  assert.equal(validateLaunchTrace(trace).executionAuthorized, false);
  assert.throws(() => validateLaunchTrace(['candidateHandleOpened', 'pinMismatch', 'launchDenied']), /LAUNCH_FAILURE_NOT_FAIL_CLOSED/);
});
