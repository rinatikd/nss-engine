const SUCCESS = Object.freeze([
  'candidateHandleOpened',
  'hashSignerAclPinsVerified',
  'createProcessSuspended',
  'childImageFileIdAndHashMatched',
  'appContainerTokenAndCapabilitiesMatched',
  'jobAssignedWithBreakawayDisabled',
  'explicitHandleListAndEnvironmentMatched',
  'resumeThread',
]);
const FORBIDDEN = new Set(['fallbackLaunch', 'resumeBeforeVerification', 'arbitraryShellCommand']);

/**
 * Validate a synthetic event fixture for design review only. This does not invoke Win32,
 * create a process, validate event provenance, or prove OS confinement.
 */
export function validateLaunchTrace(events) {
  if (!Array.isArray(events) || events.length > 32 || events.some(e => typeof e !== 'string')) throw new Error('LAUNCH_TRACE_INVALID');
  if (events.some(e => FORBIDDEN.has(e))) throw new Error('LAUNCH_TRACE_FORBIDDEN_EVENT');
  if (events.at(-1) === 'resumeThread') {
    if (JSON.stringify(events) !== JSON.stringify(SUCCESS)) throw new Error('LAUNCH_RESUME_ORDER_INVALID');
    return Object.freeze({ protocolShapeValid: true, nativeCallsObserved: false, osIsolationProven: false, executionAuthorized: false });
  }
  if (!events.includes('launchDenied') || !events.includes('rollbackStarted') || events.includes('resumeThread')) throw new Error('LAUNCH_FAILURE_NOT_FAIL_CLOSED');
  const rollback = events.slice(events.indexOf('rollbackStarted') + 1);
  const hasChild = events.includes('createProcessSuspended');
  const required = hasChild ? ['terminateChild', 'waitChildExit', 'closeJob', 'closeHandles', 'launchDenied'] : ['closeHandles', 'launchDenied'];
  if (JSON.stringify(rollback) !== JSON.stringify(required)) throw new Error('LAUNCH_ROLLBACK_ORDER_INVALID');
  if (hasChild && events.indexOf('rollbackStarted') < events.indexOf('createProcessSuspended')) throw new Error('LAUNCH_ROLLBACK_ORDER_INVALID');
  return Object.freeze({ protocolShapeValid: true, nativeCallsObserved: false, osIsolationProven: false, executionAuthorized: false });
}

export const successfulLaunchFixture = Object.freeze([...SUCCESS]);
