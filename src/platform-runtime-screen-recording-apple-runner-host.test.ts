import { expect, test, vi } from 'vitest';
import {
  captureAppleClockAnchor,
  retrieveAppleRunnerRecording,
  runAppleRecordingRunner,
} from './platform-runtime-screen-recording-apple-runner-host.ts';
import { withAppleRunnerScreenRecordingTransport } from './platform-runtime-screen-recording-apple-runner-transport.ts';
import { withAppleSimulatorScreenRecordingTransport } from './platform-runtime-screen-recording-apple-transport.ts';

const runnerClient = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  runAppleRunnerCommand: runnerClient.run,
}));

const simulator = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'sim',
  name: 'Simulator',
  kind: 'simulator' as const,
  target: 'mobile' as const,
  booted: true,
};

test('generic scoped runner recording fails closed without invoking local runner mechanics', async () => {
  runnerClient.run.mockReset();
  await withAppleRunnerScreenRecordingTransport(undefined, async () => {
    await expect(
      runAppleRecordingRunner(simulator, {
        kind: 'start',
        appBundleId: 'com.example.app',
        outputPath: '/tmp/capture.mp4',
      }),
    ).rejects.toThrow('does not expose durable recording authority');
  });
  expect(runnerClient.run).not.toHaveBeenCalled();
});

test('focused simulator-only transport never warms a local Apple runner', async () => {
  runnerClient.run.mockReset();
  await withAppleSimulatorScreenRecordingTransport(
    {
      available: true,
      mode: 'transport-composed',
      start: async () => {
        throw new Error('unused');
      },
    },
    async () => {
      await expect(captureAppleClockAnchor(simulator, 'com.example.app')).resolves.toBeUndefined();
    },
  );
  expect(runnerClient.run).not.toHaveBeenCalled();
});

test('focused provider owns retrieval for its exact recording authority', async () => {
  const recordingAuthority = Object.freeze({
    runnerSessionId: 'provider-session',
    launchIdentity: Object.freeze({
      selectorFingerprint: 'provider-selector',
      testHostContainerBundleId: 'com.example.provider.runner',
    }),
    startCommandId: 'provider-record-start',
    remotePath: 'tmp/agent-device-recording-1.mp4',
  });
  const retrieve = vi.fn(async () => {});

  await withAppleRunnerScreenRecordingTransport(
    {
      authority: 'scoped-provider',
      available: true,
      start: async () => ({ recordingAuthority, startState: 'active' }),
      inspect: async () => 'owned-alive',
      stop: async () => {},
      release: async () => {},
      retrieve,
    },
    async () => {
      await retrieveAppleRunnerRecording(
        simulator,
        'scoped-provider',
        recordingAuthority,
        '/tmp/capture.mp4',
      );
    },
  );

  expect(retrieve).toHaveBeenCalledWith({
    device: simulator,
    recordingAuthority,
    outputPath: '/tmp/capture.mp4',
    signal: undefined,
  });
});
