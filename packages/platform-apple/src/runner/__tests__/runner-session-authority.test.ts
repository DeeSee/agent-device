import {
  finalizeRecoverableRunnerRecordingLease,
  inspectRecoverableRunnerRecordingLease,
  reconcileOrphanRunnerRecordingLease,
  releaseRecoverableRunnerRecordingLease,
  retrieveRecoverableRunnerRecordingLease,
} from '../runner-recording-lease.ts';
import {
  acquireRunnerRecordingPin,
  disposeRunnerAfterRejectedRecordingStart,
  getRunnerSessionSnapshot,
  releaseRunnerRecordingPin,
  updateRunnerRecordingPin,
} from '../runner-recording-authority.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import assert from 'node:assert/strict';
import { beforeEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  makeBackgroundRunner,
  makeRunnerLease,
  makeClassifyOwnerLivenessViaMocks,
} from './runner-session-fixtures.ts';

const mocks = vi.hoisted(() => ({
  acquireRedirect: vi.fn(),
  cleanupTempFile: vi.fn(),
  ensureArtifact: vi.fn(),
  freePort: vi.fn(),
  isProcessAlive: vi.fn(),
  isProcessGroupAlive: vi.fn(),
  prepareEnv: vi.fn(),
  readProcessCommand: vi.fn(),
  readProcessStartTime: vi.fn((_pid?: number) => 'fixed-test-owner-start-time' as string | null),
  resolveDerived: vi.fn(),
  resolveSelection: vi.fn(),
  runAppleTool: vi.fn(),
  runBackground: vi.fn(),
  runXcrun: vi.fn(),
  signalPids: vi.fn(),
  signalProcessGroup: vi.fn(),
  waitForRunner: vi.fn(),
  releaseRedirect: vi.fn(),
}));

vi.mock('../runner-io.ts', async () => ({
  ...(await vi.importActual<typeof import('../runner-io.ts')>('../runner-io.ts')),
  cleanupTempFile: mocks.cleanupTempFile,
  getFreePort: mocks.freePort,
}));

vi.mock('../runner-startup-transport.ts', async () => ({
  ...(await vi.importActual<typeof import('../runner-startup-transport.ts')>(
    '../runner-startup-transport.ts',
  )),
  waitForRunner: mocks.waitForRunner,
}));

vi.mock('../runner-xctestrun.ts', async () => ({
  ...(await vi.importActual<typeof import('../runner-xctestrun.ts')>('../runner-xctestrun.ts')),
  acquireXcodebuildSimulatorSetRedirect: mocks.acquireRedirect,
  ensureXctestrunArtifact: mocks.ensureArtifact,
  prepareXctestrunWithEnv: mocks.prepareEnv,
  resolveRunnerLaunchSelection: mocks.resolveSelection,
}));

import { abortAllIosRunnerSessions, ensureRunnerSession } from '../runner-session.ts';
import {
  cleanupOwnedRunnerLease,
  cleanupRunnerLeasesForOwner,
  prepareRunnerLeaseForStartup,
  runnerOwnerToken,
  writeRunnerLease,
  type RunnerLeaseCleanupAdapter,
} from '../runner-lease.ts';

beforeEach(async () => {
  appleRunnerTestHost.update({
    runCmdBackground: mocks.runBackground,
    isProcessAlive: mocks.isProcessAlive,
    isProcessGroupAlive: mocks.isProcessGroupAlive,
    readProcessCommand: mocks.readProcessCommand,
    readProcessStartTime: mocks.readProcessStartTime,
    signalPidsBestEffort: mocks.signalPids,
    signalProcessGroupBestEffort: mocks.signalProcessGroup,
    runAppleToolCommand: mocks.runAppleTool,
    runXcrun: mocks.runXcrun,
    leaseOwnerStateDir: () => undefined,
    classifyOwnerLiveness: makeClassifyOwnerLivenessViaMocks({
      isProcessAlive: (pid) => Boolean(mocks.isProcessAlive(pid)),
      readProcessStartTime: (pid) => mocks.readProcessStartTime(pid),
    }),
  });
  const { runnerSessions } = await import('../runner-session-registry.ts');
  for (const session of runnerSessions.values()) {
    session.recordingPin = undefined;
    if (session.lease) session.lease.recordingPin = undefined;
  }
  await abortAllIosRunnerSessions();
  vi.resetAllMocks();

  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync(
    'agent-device-runner-authority-test-',
  );
  mocks.runXcrun.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mocks.ensureArtifact.mockImplementation(async (_device, options) => ({
    xctestrunPath: '/tmp/base-runner.xctestrun',
    derived: options.runnerLaunchSelection.derived,
    cache: 'miss',
    artifact: 'rebuilt',
    buildMs: 12,
    xctestrunPathSource: 'build',
    launchIdentity: options.runnerLaunchSelection.identity,
  }));
  mocks.freePort.mockResolvedValue(8123);
  mocks.prepareEnv.mockResolvedValue({
    xctestrunPath: '/tmp/session-runner.xctestrun',
    jsonPath: '/tmp/session-runner.json',
  });
  mocks.resolveDerived.mockReturnValue('/tmp/derived');
  mocks.resolveSelection.mockImplementation(async (_device, options = {}) => {
    const external = options.iosXctestrunFile;
    const derived = external ? `${external}.derived` : mocks.resolveDerived();
    return {
      source: external ? 'external' : 'internal',
      identity: {
        selectorFingerprint: external ?? `internal:${derived}`,
        testHostContainerBundleId: 'com.example.runner.xctrunner',
      },
      derived,
      ...(external ? { xctestrunPath: external } : {}),
    };
  });
  mocks.acquireRedirect.mockResolvedValue({ release: mocks.releaseRedirect });
  mocks.runBackground.mockReturnValue(makeBackgroundRunner(4242));
  mocks.runAppleTool.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mocks.isProcessAlive.mockImplementation(
    (pid: number | undefined) => pid === process.pid || pid === 4242,
  );
  mocks.isProcessGroupAlive.mockReturnValue(false);
  mocks.readProcessCommand.mockReturnValue(null);
  mocks.readProcessStartTime.mockImplementation((pid?: number) =>
    pid === process.pid ? 'fixed-test-owner-start-time' : null,
  );
});

test('internal selector change restarts the alive runner', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-internal-cutover' };
  const session = await ensureRunnerSession(device, {});
  mocks.resolveDerived.mockReturnValue('/tmp/derived-next');

  const restarted = await ensureRunnerSession(device, {});

  assert.notEqual(restarted, session);
  assert.equal(restarted.xctestrunArtifact?.derived, '/tmp/derived-next');
  assert.equal(mocks.runBackground.mock.calls.length, 2);
});

test('external selector change restarts instead of reusing the old runner', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-external-cutover' };
  const first = await ensureRunnerSession(device, { iosXctestrunFile: '/tmp/runner-a.xctestrun' });

  const second = await ensureRunnerSession(device, {
    iosXctestrunFile: '/tmp/runner-b.xctestrun',
  });

  assert.notEqual(second, first);
  assert.equal(second.launchIdentity.selectorFingerprint, '/tmp/runner-b.xctestrun');
  assert.equal(mocks.runBackground.mock.calls.length, 2);
});

test('recording authority blocks cutover and stale recording tokens', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-recording-pin' };
  const session = await ensureRunnerSession(device, {});
  const authority = await acquireRunnerRecordingPin(
    device,
    { startCommandId: 'record-start-1', remotePath: 'tmp/recording-1.mp4' },
    {},
  );
  mocks.resolveDerived.mockReturnValue('/tmp/derived-next');

  await assert.rejects(ensureRunnerSession(device, {}), hasReason('runner_session_pinned'));
  await assert.rejects(
    updateRunnerRecordingPin(
      device.id,
      { ...authority, startCommandId: 'stale-record-start' },
      'finalized',
    ),
    hasReason('runner_session_ownership_changed'),
  );
  await assert.rejects(
    releaseRunnerRecordingPin(device.id, authority, 'retrieved'),
    hasReason('runner_recording_not_finalized'),
  );

  await updateRunnerRecordingPin(device.id, authority, 'finalized');
  await releaseRunnerRecordingPin(device.id, authority, 'retrieved');
  const restarted = await ensureRunnerSession(device, {});
  assert.notEqual(restarted.sessionId, session.sessionId);
});

test('rejected recording disposal retains the exact pin through runner effects', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-rejected-start-disposal' };
  await ensureRunnerSession(device, {});
  const authority = await acquireRunnerRecordingPin(
    device,
    { startCommandId: 'rejected-record-start' },
    {},
  );
  let runnerAlive = true;
  mocks.isProcessAlive.mockImplementation(
    (pid: number | undefined) => pid === process.pid || (pid === 4242 && runnerAlive),
  );
  mocks.signalPids.mockImplementation(() => {
    assert.deepEqual(getRunnerSessionSnapshot(device.id)?.recordingAuthority, authority);
    runnerAlive = false;
  });

  await disposeRunnerAfterRejectedRecordingStart(device.id, authority);

  assert.equal(getRunnerSessionSnapshot(device.id), null);
  assert.ok(mocks.signalPids.mock.calls.length > 0);
});

test('failed rejected-recording disposal leaves the exact reuse fence intact', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-rejected-start-failure' };
  await ensureRunnerSession(device, {});
  const authority = await acquireRunnerRecordingPin(
    device,
    { startCommandId: 'rejected-record-start' },
    {},
  );
  await assert.rejects(
    disposeRunnerAfterRejectedRecordingStart(device.id, authority),
    hasReason('runner_disposal_unconfirmed'),
  );

  assert.deepEqual(getRunnerSessionSnapshot(device.id)?.recordingAuthority, authority);
  await assert.rejects(
    acquireRunnerRecordingPin(device, { startCommandId: 'competing-record-start' }, {}),
    hasReason('runner_session_pinned'),
  );

  mocks.isProcessAlive.mockImplementation((pid?: number) => pid === process.pid);
  await disposeRunnerAfterRejectedRecordingStart(device.id, authority);
});

test('exact session commands never resolve ambient selectors', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-authority-exact-session' };
  const session = await ensureRunnerSession(device, {});
  mocks.resolveSelection.mockClear();

  const exact = await ensureRunnerSession(device, {
    expectedRunnerSessionId: session.sessionId,
    iosXctestrunFile: '/must/not/be/read.xctestrun',
  });

  assert.equal(exact, session);
  assert.equal(mocks.resolveSelection.mock.calls.length, 0);
  await assert.rejects(
    ensureRunnerSession(device, {
      expectedRunnerSessionId: session.sessionId,
      expectedRunnerLaunchIdentity: {
        ...session.launchIdentity,
        selectorFingerprint: 'wrong-selector',
      },
    }),
    hasReason('runner_session_ownership_changed'),
  );
  assert.equal(mocks.resolveSelection.mock.calls.length, 0);
});

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

function pinnedLease(
  deviceId: string,
  overrides: Readonly<{ ownerPid?: number; ownerToken?: string }> = {},
) {
  const lease = makeRunnerLease({ deviceId, ...overrides });
  const ownedLease = overrides.ownerToken
    ? lease
    : {
        ...lease,
        ownerPid: process.pid,
        ownerStartTime: 'fixed-test-owner-start-time',
        ownerToken: runnerOwnerToken(),
      };
  return {
    ...ownedLease,
    recordingPin: {
      authority: {
        runnerSessionId: lease.sessionId,
        launchIdentity: lease.launchIdentity,
        startCommandId: `record-start-${deviceId}`,
        remotePath: `tmp/${deviceId}.mp4`,
      },
      state: 'nonfinalized' as const,
    },
  };
}

function hasReason(reason: string) {
  return (error: unknown) => error instanceof AppError && error.details?.reason === reason;
}
