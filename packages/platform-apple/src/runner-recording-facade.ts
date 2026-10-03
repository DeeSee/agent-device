/** Bind host capabilities before exposing operations on durable recording authority. */
export async function loadAppleRunnerRecordingOperations() {
  const client = await import('./core/runner-client.ts');
  const [authority, leases, transport, contract, session] = await Promise.all([
    import('./runner/runner-recording-authority.ts'),
    import('./runner/runner-recording-lease.ts'),
    import('./runner/runner-transport.ts'),
    import('./runner/runner-contract.ts'),
    import('./runner/runner-session-types.ts'),
  ]);
  return Object.freeze({
    acquireRunnerRecordingPin: authority.acquireRunnerRecordingPin,
    assertRunnerRecordingAuthority: authority.assertRunnerRecordingAuthority,
    disposeRunnerAfterRejectedRecordingStart: authority.disposeRunnerAfterRejectedRecordingStart,
    getRunnerSessionSnapshot: authority.getRunnerSessionSnapshot,
    releaseRunnerRecordingPin: authority.releaseRunnerRecordingPin,
    rollbackRunnerRecordingPin: authority.rollbackRunnerRecordingPin,
    updateRunnerRecordingPin: authority.updateRunnerRecordingPin,
    reconcileOrphanRunnerRecordingLease: leases.reconcileOrphanRunnerRecordingLease,
    inspectRecoverableRunnerRecordingLease: leases.inspectRecoverableRunnerRecordingLease,
    finalizeRecoverableRunnerRecordingLease: leases.finalizeRecoverableRunnerRecordingLease,
    retrieveRecoverableRunnerRecordingLease: leases.retrieveRecoverableRunnerRecordingLease,
    releaseRecoverableRunnerRecordingLease: leases.releaseRecoverableRunnerRecordingLease,
    runAppleRunnerCommandWithReceipt: client.runAppleRunnerCommandWithReceipt,
    runAppleRunnerCommand: client.runAppleRunnerCommand,
    sameRunnerRecordingAuthority: session.sameRunnerRecordingAuthority,
    withRunnerCommandId: contract.withRunnerCommandId,
    decodeRunnerResponseBody: contract.decodeRunnerResponseBody,
    isRunnerResponseOk: contract.isRunnerResponseOk,
    buildRunnerResponseError: contract.buildRunnerResponseError,
    sendRunnerCommandOnce: transport.sendRunnerCommandOnce,
    RUNNER_COMMAND_TIMEOUT_MS: transport.RUNNER_COMMAND_TIMEOUT_MS,
    runnerCommandDispatchWasAttempted: transport.runnerCommandDispatchWasAttempted,
    runnerCommandWasRejected: transport.runnerCommandWasRejected,
  });
}
