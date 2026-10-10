import { beforeEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  reconcileLocalAppleRunnerRecordingOrphan,
  resolveAppleRunnerScreenRecordingTransport,
  withAppleRunnerScreenRecordingTransport,
} from './platform-runtime-screen-recording-apple-runner-transport.ts';

const runner = vi.hoisted(() => ({
  acquire: vi.fn(),
  assertAuthority: vi.fn(),
  disposeRejectedStart: vi.fn(),
  release: vi.fn(),
  rollback: vi.fn(),
  run: vi.fn(),
  runWithReceipt: vi.fn(),
  snapshot: vi.fn(),
  stop: vi.fn(),
  update: vi.fn(),
}));

const recovery = vi.hoisted(() => ({
  finalize: vi.fn(),
  reconcileOrphan: vi.fn(),
  release: vi.fn(),
  retrieve: vi.fn(),
  send: vi.fn(),
  copy: vi.fn(),
  simctl: vi.fn(),
  hostCopy: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/runner/recording', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/recording')>();
  return {
    loadAppleRunnerRecordingOperations: async () => ({
      ...(await actual.loadAppleRunnerRecordingOperations()),
      acquireRunnerRecordingPin: runner.acquire,
      assertRunnerRecordingAuthority: runner.assertAuthority,
      disposeRunnerAfterRejectedRecordingStart: runner.disposeRejectedStart,
      releaseRunnerRecordingPin: runner.release,
      rollbackRunnerRecordingPin: runner.rollback,
      runAppleRunnerCommand: runner.run,
      runAppleRunnerCommandWithReceipt: runner.runWithReceipt,
      getRunnerSessionSnapshot: runner.snapshot,
      updateRunnerRecordingPin: runner.update,
      finalizeRecoverableRunnerRecordingLease: recovery.finalize,
      reconcileOrphanRunnerRecordingLease: recovery.reconcileOrphan,
      releaseRecoverableRunnerRecordingLease: recovery.release,
      retrieveRecoverableRunnerRecordingLease: recovery.retrieve,
      sendRunnerCommandOnce: recovery.send,
    }),
  };
});

vi.mock('@agent-device/platform-apple/physical-device', () => ({
  resolveIosPhysicalDeviceControl: () => ({ copyRunnerFile: recovery.copy }),
}));

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: recovery.simctl,
}));
vi.mock('@agent-device/host-kit/host-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/host-file')>()),
  copyHostFile: recovery.hostCopy,
}));

const launchIdentity = Object.freeze({
  selectorFingerprint: 'selector-a',
  testHostContainerBundleId: 'com.example.runner.xctrunner',
});

const receipt = Object.freeze({
  runnerSessionId: 'runner-session-1',
  launchIdentity,
});

const recordingAuthority = Object.freeze({
  ...receipt,
  startCommandId: 'record-start-1',
  remotePath: 'tmp/agent-device-recording-1.mp4',
});

const device = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'device',
  name: 'iPhone',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  runner.acquire.mockResolvedValue(recordingAuthority);
  runner.assertAuthority.mockResolvedValue('nonfinalized');
  runner.disposeRejectedStart.mockResolvedValue(undefined);
  runner.runWithReceipt.mockResolvedValue({ data: {}, receipt });
  runner.run.mockResolvedValue({});
  runner.snapshot.mockReturnValue({ alive: true });
  runner.stop.mockResolvedValue(undefined);
  runner.update.mockResolvedValue(undefined);
  runner.release.mockResolvedValue(undefined);
  runner.rollback.mockResolvedValue(undefined);
  recovery.finalize.mockImplementation(async (_deviceId, _authority, effect) => {
    await effect({
      port: 8123,
      testHostContainerBundleId: launchIdentity.testHostContainerBundleId,
      artifactSource: 'external',
    });
    return 'finalized';
  });
  recovery.reconcileOrphan.mockImplementation(async (_deviceId, effect) => {
    await effect({
      port: 8123,
      testHostContainerBundleId: launchIdentity.testHostContainerBundleId,
      artifactSource: 'external',
      recordingAuthority,
    });
    return 'reconciled';
  });
  recovery.release.mockResolvedValue('released');
  recovery.retrieve.mockImplementation(async (_deviceId, authority, effect) => {
    await effect({
      port: 8123,
      testHostContainerBundleId: authority.launchIdentity.testHostContainerBundleId,
      artifactSource: 'external',
      remotePath: authority.remotePath,
    });
    return 'retrieved';
  });
  recovery.send.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} })));
  recovery.copy.mockResolvedValue(undefined);
});

const macosDevice = {
  ...device,
  appleOs: 'macos' as const,
  id: 'host-macos-local',
  name: 'Mac',
  target: 'desktop' as const,
};

test('scopes an unavailable runner authority instead of falling back to a local lease', async () => {
  await withAppleRunnerScreenRecordingTransport(undefined, async () => {
    const transport = resolveAppleRunnerScreenRecordingTransport();
    expect(transport).toMatchObject({ available: false, authority: 'scoped-provider' });
    await expect(
      transport.start({
        device,
        appBundleId: 'com.example.app',
        outputPath: '/tmp/capture.mp4',
      }),
    ).rejects.toThrow('does not expose durable recording authority');
  });
});

test('passes the recorded session identity into the runner stop dispatch boundary', async () => {
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await transport.stop({
    device,
    recordingAuthority,
  });

  expect(runner.run).toHaveBeenCalledWith(
    device,
    {
      command: 'recordStop',
      appBundleId: undefined,
      recordingStartCommandId: recordingAuthority.startCommandId,
    },
    {
      signal: undefined,
      expectedRunnerSessionId: 'runner-session-1',
      expectedRunnerLaunchIdentity: launchIdentity,
    },
  );
  expect(runner.update).toHaveBeenCalledWith(device.id, recordingAuthority, 'finalized');
  expect(runner.release).not.toHaveBeenCalled();
});

test('daemon-loss stop dispatches only through the exact recoverable lease', async () => {
  runner.snapshot.mockReturnValue(null);
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await transport.stop({ device, recordingAuthority, appBundleId: 'com.example.app' });

  expect(recovery.finalize).toHaveBeenCalledWith(
    device.id,
    recordingAuthority,
    expect.any(Function),
  );
  expect(recovery.send).toHaveBeenCalledWith(
    device,
    8123,
    expect.objectContaining({
      command: 'recordStop',
      appBundleId: 'com.example.app',
      recordingStartCommandId: recordingAuthority.startCommandId,
    }),
    expect.any(Number),
    undefined,
  );
  expect(runner.run).not.toHaveBeenCalled();
});

test('daemon-loss retrieval derives the source path from exact authority', async () => {
  runner.snapshot.mockReturnValue(null);
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await transport.retrieve({ device, recordingAuthority, outputPath: '/tmp/capture.mp4' });

  expect(recovery.retrieve).toHaveBeenCalledWith(
    device.id,
    recordingAuthority,
    expect.any(Function),
  );
  expect(recovery.copy).toHaveBeenCalledWith(
    device,
    recordingAuthority.remotePath,
    '/tmp/capture.mp4',
    launchIdentity.testHostContainerBundleId,
    undefined,
    undefined,
  );
});

test('cancellation during active media copy retains the exact runner pin for retry', async () => {
  let releaseCopy: () => void = () => {};
  const copyStarted = new Promise<void>((resolveStarted) => {
    recovery.copy.mockImplementationOnce(async () => {
      resolveStarted();
      await new Promise<void>((resolveCopy) => {
        releaseCopy = resolveCopy;
      });
    });
  });
  const controller = new AbortController();
  const reason = new Error('cancel media retrieval');
  const transport = resolveAppleRunnerScreenRecordingTransport();

  const retrieval = transport.retrieve({
    device,
    recordingAuthority,
    outputPath: '/tmp/capture.mp4',
    signal: controller.signal,
  });
  await copyStarted;
  controller.abort(reason);
  releaseCopy();

  await expect(retrieval).rejects.toBe(reason);
  expect(recovery.copy).toHaveBeenCalledWith(
    device,
    recordingAuthority.remotePath,
    '/tmp/capture.mp4',
    launchIdentity.testHostContainerBundleId,
    undefined,
    controller.signal,
  );
  expect(runner.release).not.toHaveBeenCalled();
});

test('cancellation after dispatch returns uncertain authority for durable adoption', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel after runner acquisition');
  runner.runWithReceipt.mockImplementation(async () => {
    controller.abort(reason);
    return { data: {}, receipt };
  });
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device,
      appBundleId: 'com.example.app',
      outputPath: '/tmp/capture.mp4',
      signal: controller.signal,
    }),
  ).resolves.toEqual({ recordingAuthority, startState: 'uncertain' });

  expect(runner.run).not.toHaveBeenCalled();
  expect(runner.update).not.toHaveBeenCalled();
  expect(runner.release).not.toHaveBeenCalled();
});

test('orphan reconciliation stops only the recording pinned by the exact lease', async () => {
  await expect(reconcileLocalAppleRunnerRecordingOrphan(device)).resolves.toBe('reconciled');

  expect(recovery.reconcileOrphan).toHaveBeenCalledWith(device.id, expect.any(Function));
  expect(recovery.send).toHaveBeenCalledWith(
    device,
    8123,
    expect.objectContaining({
      command: 'recordStop',
      recordingStartCommandId: recordingAuthority.startCommandId,
    }),
    expect.any(Number),
    undefined,
  );
  expect(runner.run).not.toHaveBeenCalled();
});

test('preserves a typed recording-authority refusal from orphan reconciliation', async () => {
  recovery.send.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: 'RECORDING_AUTHORITY_MISMATCH',
          message: 'recordStop authority does not match the active recording',
        },
      }),
    ),
  );

  await expect(reconcileLocalAppleRunnerRecordingOrphan(device)).rejects.toMatchObject({
    code: 'RECORDING_AUTHORITY_MISMATCH',
    message: 'recordStop authority does not match the active recording',
  });
});

test('retains the durable pin when exact recordStart dispatch fails', async () => {
  runner.runWithReceipt.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'transport uncertain', {
      runnerCommandDispatch: 'attempted',
    }),
  );
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device,
      appBundleId: 'com.example.app',
      outputPath: '/tmp/capture.mp4',
    }),
  ).resolves.toEqual({
    recordingAuthority,
    startState: 'uncertain',
  });

  expect(runner.acquire).toHaveBeenCalledOnce();
  expect(runner.update).not.toHaveBeenCalled();
  expect(runner.release).not.toHaveBeenCalled();
});

test('retains the durable pin when status recovery wraps an attempted dispatch', async () => {
  const attempted = new AppError('COMMAND_FAILED', 'transport uncertain', {
    runnerCommandDispatch: 'attempted',
  });
  runner.runWithReceipt.mockRejectedValue(
    new AppError(
      'COMMAND_FAILED',
      'recordStart is still in flight after status recovery',
      { recovery: 'command_still_in_flight' },
      attempted,
    ),
  );
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device,
      appBundleId: 'com.example.app',
      outputPath: '/tmp/capture.mp4',
    }),
  ).resolves.toMatchObject({ startState: 'uncertain' });

  expect(runner.rollback).not.toHaveBeenCalled();
  expect(runner.update).not.toHaveBeenCalled();
});

test('rolls back a terminal runner rejection after dispatch', async () => {
  const failure = new AppError('COMMAND_FAILED', 'recordStart was rejected', {
    runnerCommandDispatch: 'attempted',
    runnerCommandOutcome: 'rejected',
  });
  runner.runWithReceipt.mockRejectedValue(failure);
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device,
      appBundleId: 'com.example.app',
      outputPath: '/tmp/capture.mp4',
    }),
  ).rejects.toBe(failure);

  expect(runner.rollback).toHaveBeenCalledWith(device.id, recordingAuthority);
  expect(runner.stop).not.toHaveBeenCalled();
});

test('resets an incoherent runner after it rejects recordStart as already active', async () => {
  const failure = new AppError('COMMAND_FAILED', 'recording already in progress', {
    runnerCommandDispatch: 'attempted',
    runnerCommandOutcome: 'rejected',
    runnerErrorCode: 'RECORDING_ALREADY_ACTIVE',
  });
  runner.runWithReceipt.mockRejectedValue(failure);
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device,
      appBundleId: 'com.example.app',
      outputPath: '/tmp/capture.mp4',
    }),
  ).rejects.toBe(failure);

  expect(runner.disposeRejectedStart).toHaveBeenCalledWith(device.id, recordingAuthority);
  expect(runner.rollback).not.toHaveBeenCalled();
  expect(runner.stop).not.toHaveBeenCalled();
});

test('preserves the terminal recording rejection when incoherent-runner reset fails', async () => {
  const failure = new AppError('COMMAND_FAILED', 'recording already in progress', {
    runnerCommandDispatch: 'attempted',
    runnerCommandOutcome: 'rejected',
    runnerErrorCode: 'RECORDING_ALREADY_ACTIVE',
  });
  runner.runWithReceipt.mockRejectedValue(failure);
  runner.disposeRejectedStart.mockRejectedValue(new Error('runner shutdown failed'));
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device,
      appBundleId: 'com.example.app',
      outputPath: '/tmp/capture.mp4',
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'recording already in progress',
    details: {
      runnerCommandOutcome: 'rejected',
      runnerErrorCode: 'RECORDING_ALREADY_ACTIVE',
      runnerResetFailure: 'runner shutdown failed',
    },
  });

  expect(runner.disposeRejectedStart).toHaveBeenCalledWith(device.id, recordingAuthority);
  expect(runner.rollback).not.toHaveBeenCalled();
});

test('rolls back only a proven pre-send recording start failure', async () => {
  const failure = new Error('runner readiness failed before command send');
  runner.runWithReceipt.mockRejectedValue(failure);
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device,
      appBundleId: 'com.example.app',
      outputPath: '/tmp/capture.mp4',
    }),
  ).rejects.toBe(failure);

  expect(runner.rollback).toHaveBeenCalledWith(device.id, recordingAuthority);
  expect(runner.update).not.toHaveBeenCalled();
});

test('forwards the exact external runner selection into pin acquisition', async () => {
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await transport.start({
    device,
    appBundleId: 'com.example.app',
    outputPath: '/tmp/capture.mp4',
    iosXctestrunFile: '/artifacts/runner.xctestrun',
    iosXctestDerivedDataPath: '/private/run/derived',
    iosXctestEnvDir: '/private/run/env',
  });

  expect(runner.acquire).toHaveBeenCalledWith(
    device,
    expect.objectContaining({ startCommandId: expect.any(String) }),
    {
      signal: undefined,
      iosXctestrunFile: '/artifacts/runner.xctestrun',
      iosXctestDerivedDataPath: '/private/run/derived',
      iosXctestEnvDir: '/private/run/env',
    },
  );
});

test('refuses a stale recording authority before recordStop dispatch', async () => {
  const transport = resolveAppleRunnerScreenRecordingTransport();
  const refusal = new AppError('COMMAND_FAILED', 'recording ownership changed', {
    reason: 'runner_session_ownership_changed',
  });
  runner.assertAuthority.mockRejectedValueOnce(refusal);

  await expect(
    transport.stop({
      device,
      recordingAuthority: { ...recordingAuthority, startCommandId: 'stale-start' },
    }),
  ).rejects.toBe(refusal);

  expect(runner.run).not.toHaveBeenCalled();
  expect(runner.update).not.toHaveBeenCalled();
});

test('keeps macOS runner recording ownership local to the requested output path', async () => {
  const macosAuthority = Object.freeze({ ...receipt, startCommandId: 'record-start-macos' });
  runner.acquire.mockResolvedValue(macosAuthority);
  runner.runWithReceipt.mockResolvedValue({ data: { recorderStartUptimeMs: 42 }, receipt });
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device: macosDevice,
      appBundleId: 'com.apple.TextEdit',
      outputPath: '/tmp/capture.mp4',
    }),
  ).resolves.toEqual({
    recordingAuthority: macosAuthority,
    startState: 'active',
    recorderStartUptimeMs: 42,
  });

  expect(runner.runWithReceipt).toHaveBeenCalledWith(
    macosDevice,
    expect.objectContaining({
      command: 'recordStart',
      outPath: '/tmp/capture.mp4',
      appBundleId: 'com.apple.TextEdit',
    }),
    {
      signal: undefined,
      expectedRunnerSessionId: 'runner-session-1',
      expectedRunnerLaunchIdentity: launchIdentity,
    },
  );
});

for (const alive of [true, false]) {
  test(`simulator recording retrieval preserves exact authority after daemon alive=${alive}`, async () => {
    runner.snapshot.mockReturnValue(alive ? { alive: true } : null);
    recovery.simctl.mockResolvedValue({
      stdout: '/tmp/exact-runner-container\n',
      stderr: '',
      exitCode: 0,
    });
    const transport = resolveAppleRunnerScreenRecordingTransport();
    const simulator = { ...device, kind: 'simulator' as const };
    recovery.hostCopy.mockRejectedValueOnce(new Error('copy interrupted'));
    await expect(
      transport.retrieve({ device: simulator, recordingAuthority, outputPath: '/tmp/capture.mp4' }),
    ).rejects.toThrow('copy interrupted');
    expect(runner.release).not.toHaveBeenCalled();
    recovery.hostCopy.mockResolvedValueOnce(undefined);
    await transport.retrieve({
      device: simulator,
      recordingAuthority,
      outputPath: '/tmp/capture.mp4',
    });
    expect(recovery.simctl).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'get_app_container', device.id, launchIdentity.testHostContainerBundleId, 'data'],
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(recovery.hostCopy).toHaveBeenCalledWith(
      '/tmp/exact-runner-container/' + recordingAuthority.remotePath,
      '/tmp/capture.mp4',
    );
    expect(recovery.copy).not.toHaveBeenCalled();
    if (alive)
      expect(runner.release).toHaveBeenCalledWith(device.id, recordingAuthority, 'retrieved');
  });
}
