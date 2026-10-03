import { mocks, hasReason, pinnedLease } from './runner-recording.fixtures.ts';
import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import {
  finalizeRecoverableRunnerRecordingLease,
  inspectRecoverableRunnerRecordingLease,
  reconcileOrphanRunnerRecordingLease,
  releaseRecoverableRunnerRecordingLease,
  retrieveRecoverableRunnerRecordingLease,
} from '../runner-recording-lease.ts';
import {
  cleanupOwnedRunnerLease,
  cleanupRunnerLeasesForOwner,
  prepareRunnerLeaseForStartup,
  writeRunnerLease,
  type RunnerLeaseCleanupAdapter,
} from '../runner-lease.ts';
test('stale and explicitly owned pinned leases refuse generic cleanup effects', async () => {
  const staleDeviceId = 'runner-authority-stale-pin';
  const ownedDeviceId = 'runner-authority-owned-pin';
  const daemonCleanupDeviceId = 'runner-authority-daemon-cleanup-pin';
  const cleanup: RunnerLeaseCleanupAdapter = {
    cleanupRunnerProcessTree: vi.fn(async () => {}),
    cleanupRunnerXcodebuildProcesses: vi.fn(async () => {}),
    cleanupTempFile: vi.fn(),
  };
  writeRunnerLease(pinnedLease(staleDeviceId, { ownerPid: 99999, ownerToken: 'dead-owner' }));
  writeRunnerLease(pinnedLease(ownedDeviceId));
  writeRunnerLease(pinnedLease(daemonCleanupDeviceId));

  await assert.rejects(
    prepareRunnerLeaseForStartup({ ...IOS_SIMULATOR, id: staleDeviceId }, cleanup),
    hasReason('runner_session_pinned'),
  );
  await assert.rejects(
    cleanupOwnedRunnerLease(ownedDeviceId, cleanup),
    hasReason('runner_session_pinned'),
  );
  await assert.rejects(
    cleanupRunnerLeasesForOwner(
      { pid: process.pid, startTime: 'fixed-test-owner-start-time' },
      cleanup,
    ),
    hasReason('runner_session_pinned'),
  );
  assert.equal(vi.mocked(cleanup.cleanupRunnerProcessTree).mock.calls.length, 0);
  assert.equal(vi.mocked(cleanup.cleanupRunnerXcodebuildProcesses).mock.calls.length, 0);
});

test('exact lease recovery stops once, derives its media path, and releases the pin', async () => {
  const deviceId = 'runner-authority-exact-lease-recovery';
  const lease = pinnedLease(deviceId);
  const authority = lease.recordingPin.authority;
  const stop = vi.fn(async () => {});
  const retrieve = vi.fn(async () => {});
  mocks.readProcessCommand.mockReturnValue('xcodebuild AgentDeviceRunner');
  writeRunnerLease(lease);

  await expect(inspectRecoverableRunnerRecordingLease(deviceId, authority)).resolves.toBe(
    'owned-alive',
  );
  await expect(finalizeRecoverableRunnerRecordingLease(deviceId, authority, stop)).resolves.toBe(
    'finalized',
  );
  await expect(finalizeRecoverableRunnerRecordingLease(deviceId, authority, stop)).resolves.toBe(
    'finalized',
  );
  await expect(
    retrieveRecoverableRunnerRecordingLease(deviceId, authority, retrieve),
  ).resolves.toBe('retrieved');

  expect(stop).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledWith({
    port: lease.port,
    testHostContainerBundleId: lease.launchIdentity.testHostContainerBundleId,
    artifactSource: lease.artifactSource,
  });
  expect(retrieve).toHaveBeenCalledWith({
    port: lease.port,
    testHostContainerBundleId: lease.launchIdentity.testHostContainerBundleId,
    artifactSource: lease.artifactSource,
    remotePath: authority.remotePath,
  });
  await expect(inspectRecoverableRunnerRecordingLease(deviceId, authority)).resolves.toBe(
    'missing',
  );
  await expect(releaseRecoverableRunnerRecordingLease(deviceId, authority)).resolves.toBe(
    'missing',
  );
});

test('exact dead lease inspection clears only its pin without process effects', async () => {
  const deviceId = 'runner-authority-exact-dead-lease';
  const lease = pinnedLease(deviceId);
  const cleanup: RunnerLeaseCleanupAdapter = {
    cleanupRunnerProcessTree: vi.fn(async () => {}),
    cleanupRunnerXcodebuildProcesses: vi.fn(async () => {}),
    cleanupTempFile: vi.fn(),
  };
  writeRunnerLease(lease);
  mocks.isProcessAlive.mockImplementation((pid?: number) => pid === process.pid);

  await expect(
    inspectRecoverableRunnerRecordingLease(deviceId, lease.recordingPin.authority),
  ).resolves.toBe('missing');

  expect(cleanup.cleanupRunnerProcessTree).not.toHaveBeenCalled();
  expect(cleanup.cleanupRunnerXcodebuildProcesses).not.toHaveBeenCalled();
  await expect(cleanupOwnedRunnerLease(deviceId, cleanup)).resolves.toBeUndefined();
});

test('a stale dead-owner orphan pin is stopped exactly and cleared', async () => {
  const deviceId = 'runner-authority-stale-orphan-pin';
  const lease = pinnedLease(deviceId, { ownerPid: 999_999_999, ownerToken: 'dead-owner' });
  const stop = vi.fn(async () => {});
  mocks.readProcessCommand.mockReturnValue('xcodebuild AgentDeviceRunner');
  writeRunnerLease(lease);

  await expect(reconcileOrphanRunnerRecordingLease(deviceId, stop)).resolves.toBe('reconciled');

  expect(mocks.isProcessAlive).toHaveBeenCalledWith(999_999_999);
  expect(stop).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledWith({
    port: lease.port,
    testHostContainerBundleId: lease.launchIdentity.testHostContainerBundleId,
    artifactSource: lease.artifactSource,
    recordingAuthority: lease.recordingPin.authority,
  });
  await expect(
    inspectRecoverableRunnerRecordingLease(deviceId, lease.recordingPin.authority),
  ).resolves.toBe('missing');
});

test.each([
  ['session', { runnerSessionId: 'different-session' }],
  [
    'selector',
    {
      launchIdentity: {
        selectorFingerprint: 'different-selector',
        testHostContainerBundleId: 'com.example.runner.xctrunner',
      },
    },
  ],
] as const)('persisted pin with incoherent %s fails closed', async (_name, authorityOverride) => {
  const deviceId = `runner-authority-incoherent-${_name}`;
  const lease = pinnedLease(deviceId);
  writeRunnerLease({
    ...lease,
    recordingPin: {
      ...lease.recordingPin,
      authority: { ...lease.recordingPin.authority, ...authorityOverride },
    },
  });

  await assert.rejects(
    cleanupOwnedRunnerLease(deviceId, {
      cleanupRunnerProcessTree: vi.fn(async () => {}),
      cleanupRunnerXcodebuildProcesses: vi.fn(async () => {}),
      cleanupTempFile: vi.fn(),
    }),
    hasReason('runner_session_pinned'),
  );
});
