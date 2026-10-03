/** Bind host capabilities before exposing operations on durable recording authority. */
export async function loadAppleRunnerRecordingOperations() {
  const { runAppleRunnerCommandWithReceipt, runAppleRunnerCommand } =
    await import('./core/runner-client.ts');
  const {
    acquireRunnerRecordingPin,
    assertRunnerRecordingAuthority,
    disposeRunnerAfterRejectedRecordingStart,
    getRunnerSessionSnapshot,
    releaseRunnerRecordingPin,
    rollbackRunnerRecordingPin,
    updateRunnerRecordingPin,
  } = await import('./runner/runner-recording-authority.ts');
  const {
    reconcileOrphanRunnerRecordingLease,
    inspectRecoverableRunnerRecordingLease,
    finalizeRecoverableRunnerRecordingLease,
    retrieveRecoverableRunnerRecordingLease,
    releaseRecoverableRunnerRecordingLease,
  } = await import('./runner/runner-recording-lease.ts');
  const { sameRunnerRecordingAuthority } = await import('./runner/runner-session-types.ts');
  const {
    withRunnerCommandId,
    decodeRunnerResponseBody,
    isRunnerResponseOk,
    buildRunnerResponseError,
  } = await import('./runner/runner-contract.ts');
  const {
    sendRunnerCommandOnce,
    RUNNER_COMMAND_TIMEOUT_MS,
    runnerCommandDispatchWasAttempted,
    runnerCommandWasRejected,
  } = await import('./runner/runner-transport.ts');
  return Object.freeze({
    acquireRunnerRecordingPin,
    assertRunnerRecordingAuthority,
    disposeRunnerAfterRejectedRecordingStart,
    getRunnerSessionSnapshot,
    releaseRunnerRecordingPin,
    rollbackRunnerRecordingPin,
    updateRunnerRecordingPin,
    reconcileOrphanRunnerRecordingLease,
    inspectRecoverableRunnerRecordingLease,
    finalizeRecoverableRunnerRecordingLease,
    retrieveRecoverableRunnerRecordingLease,
    releaseRecoverableRunnerRecordingLease,
    runAppleRunnerCommandWithReceipt,
    runAppleRunnerCommand,
    sameRunnerRecordingAuthority,
    withRunnerCommandId,
    decodeRunnerResponseBody,
    isRunnerResponseOk,
    buildRunnerResponseError,
    sendRunnerCommandOnce,
    RUNNER_COMMAND_TIMEOUT_MS,
    runnerCommandDispatchWasAttempted,
    runnerCommandWasRejected,
  });
}
