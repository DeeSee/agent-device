import { expect, test, vi } from 'vitest';
import { assertProducedRunnerRequests } from '@agent-device/platform-apple/runner/requests-fixtures';
import { captureAppleClockAnchor } from '../platform-runtime-screen-recording-apple-runner-host.ts';
import { resolveAppleRunnerScreenRecordingTransport } from '../platform-runtime-screen-recording-apple-runner-transport.ts';

const runner = vi.hoisted(() => ({
  run: vi.fn(),
  snapshot: vi.fn(),
  acquire: vi.fn(),
  receipt: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/runner/recording', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/recording')>();
  return {
    loadAppleRunnerRecordingOperations: async () => ({
      ...(await actual.loadAppleRunnerRecordingOperations()),
      acquireRunnerRecordingPin: runner.acquire,
      getRunnerSessionSnapshot: runner.snapshot,
      assertRunnerRecordingAuthority: vi.fn(),
      updateRunnerRecordingPin: vi.fn(),
      runAppleRunnerCommand: runner.run,
      runAppleRunnerCommandWithReceipt: runner.receipt,
    }),
  };
});

vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  runAppleRunnerCommand: runner.run,
  readRunnerSessionLiveness: runner.snapshot,
}));

const device = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'device',
  name: 'iPhone',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};
const simulator = { ...device, kind: 'simulator' as const, id: 'sim' };
const macosDevice = {
  ...device,
  appleOs: 'macos' as const,
  id: 'host-macos-local',
  name: 'Mac',
  target: 'desktop' as const,
};

test('screen recording runner requests match their runner-requests.json entries', async () => {
  runner.snapshot.mockReturnValue({
    sessionId: 'runner-session-1',
    liveness: 'ready',
    alive: true,
  });
  runner.run.mockResolvedValue({});
  runner.acquire.mockImplementation(async (_device, request) => ({
    runnerSessionId: 'runner-session-1',
    launchIdentity: {
      selectorFingerprint: 'fixture',
      testHostContainerBundleId: 'com.example.runner',
    },
    ...request,
  }));
  runner.receipt.mockImplementation(async (...args) => ({ data: await runner.run(...args) }));
  const transport = resolveAppleRunnerScreenRecordingTransport();
  const request = { appBundleId: 'com.example.app', outputPath: '/tmp/capture.mp4' };

  vi.setSystemTime(1_700_000_000_000);
  let started;
  try {
    started = await transport.start({ ...request, device, fps: 30 });
  } finally {
    vi.useRealTimers();
  }
  await transport.start({ ...request, device: simulator });
  await transport.start({ ...request, device: macosDevice });
  await transport.stop({
    device,
    recordingAuthority: started.recordingAuthority,
    appBundleId: 'com.example.app',
  });
  await transport.stop({ device, recordingAuthority: started.recordingAuthority });
  const controller = new AbortController();
  const reason = new Error('cancel after runner acquisition');
  runner.receipt.mockImplementationOnce(async (...args) => {
    await runner.run(...args);
    controller.abort(reason);
    return { data: {} };
  });
  const uncertain = await transport.start({ ...request, device, signal: controller.signal });
  expect(uncertain.startState).toBe('uncertain');
  await transport.stop({
    device,
    appBundleId: request.appBundleId,
    recordingAuthority: uncertain.recordingAuthority,
  });
  await captureAppleClockAnchor(simulator, 'com.example.app');

  const sent = runner.run.mock.calls.map((call) => call[1]);
  assertProducedRunnerRequests(import.meta.filename, [
    ['ios-device.recording-start.fps', sent[0]],
    ['ios-simulator.recording-start.default', sent[1]],
    ['macos.recording-start.output-path', sent[2]],
    ['ios-device.recording-stop.session', sent[3]],
    ['ios-device.recording-stop.no-app', sent[4]],
    ['ios-device.recording-start-abort.stop', sent[6]],
    ['ios-simulator.recording-clock-anchor.snapshot', sent[7]],
  ]);
});
