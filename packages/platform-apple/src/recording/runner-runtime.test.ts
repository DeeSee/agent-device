import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';

import type { AppleScreenRecordingRunnerRequest } from '@agent-device/contracts/screen-recording-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';

import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createAppleScreenRecordingOperations } from './runtime.ts';
import {
  appleRecordingHost as appleHost,
  coreDevice,
  simulator,
  coreDeviceRunnerStart,
  recordingInput as input,
} from './runtime.fixtures.ts';

test('uses the closed Apple runner and finalizer for a CoreDevice recording', async () => {
  const calls: string[] = [];
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        availability: async () => ({ available: true, appRecordingBackend: 'runner' as const }),
        runRunner: async (_device: DeviceInfo, request: AppleScreenRecordingRunnerRequest) => {
          calls.push(request.kind);
          return {
            ...coreDeviceRunnerStart,
            recorderStartUptimeMs: 10,
          };
        },
        retrieveRunnerRecording: async (
          _device,
          runnerAuthority,
          recordingAuthority,
          outputPath,
        ) => {
          calls.push(`retrieve:${runnerAuthority}:${recordingAuthority.remotePath}:${outputPath}`);
        },
        startSimulator: async () => {
          throw new Error('unused');
        },
      },
      complete: async ({ targetLabel }) => {
        calls.push(`finalize:${targetLabel}`);
        return { telemetryPath: '/tmp/capture.gesture-telemetry.json' };
      },
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart({
    sessionId: 'one',
    outputPath: '/tmp/capture.mp4',
    scope: 'app',
    showTouches: false,
    hideTouchesRequested: true,
    recordOnlySession: false,
    activeSessionApp: { bundleId: 'com.example.app' },
    fence: { token: 'fence', generation: 1 },
  });
  const handle = started.pendingHandle.transfer();
  expect(handle.inspect()).toMatchObject({
    gestureClockOriginUptimeMs: 10,
    runnerStartedAtUptimeMs: 10,
  });
  const outcome = await handle.finish();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') {
    assert.equal(outcome.result.telemetryPath, '/tmp/capture.gesture-telemetry.json');
  }
  assert.deepEqual(calls, [
    'start',
    'stop',
    'retrieve:local-lease:tmp/agent-device-recording-123.mp4:/tmp/capture.mp4',
    'finalize:iOS recording',
  ]);
});

test('binds physical recording stop, retrieval, and finalization to the stop request signal', async () => {
  const stopController = new AbortController();
  let stopSignal: AbortSignal | undefined;
  let retrieveSignal: AbortSignal | undefined;
  let finalizerSignal: AbortSignal | undefined;
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        runRunner: async (_device, request, signal) => {
          if (request.kind === 'stop') stopSignal = signal;
          return request.kind === 'start' ? coreDeviceRunnerStart : {};
        },
        retrieveRunnerRecording: async (
          _device,
          _runnerAuthority,
          _recordingAuthority,
          _outputPath,
          signal,
        ) => {
          retrieveSignal = signal;
        },
      },
      complete: async (_input, signal) => {
        finalizerSignal = signal;
        return {};
      },
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(input({ scope: 'app' }));

  await started.pendingHandle.transfer().finish(undefined, stopController.signal);

  expect(stopSignal).toBe(stopController.signal);
  expect(retrieveSignal).toBe(stopController.signal);
  expect(finalizerSignal).toBe(stopController.signal);
});

test('a runner recording that wrote on the device reports that path as owed a retirement', async () => {
  const operations = createAppleScreenRecordingOperations({
    host: appleHost(),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const handle = (await operations.screenRecordingStart(input())).pendingHandle.transfer();

  await expect(handle.finish()).resolves.toMatchObject({
    status: 'completed',
    result: {
      stopObservation: { recorder: 'confirmed' },
      // The stop RPC was acknowledged and the file was retrieved off the device, so nothing removes
      // it here — retiring it is owed, and saying so is what lets a later step do it (ADR 0024 2.3).
      nativePathDisposition: 'retirable',
    },
  });
});

test('an invalidated runner recording still names its device-side path as owed', async () => {
  const operations = createAppleScreenRecordingOperations({
    host: appleHost(),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const handle = (
    await operations.screenRecordingStart(input({ showTouches: true }))
  ).pendingHandle.transfer();
  handle.invalidate('runner restarted');

  await expect(handle.finish()).resolves.toMatchObject({
    status: 'completed',
    result: {
      // Losing the session that held the recorder says nothing about who stopped writing, while the
      // file the runner left on the device is still there to be retired.
      stopObservation: { recorder: 'lost', why: 'owner-session-lost' },
      nativePathDisposition: 'retirable',
      overlayWarning: 'overlay unavailable: runner restarted',
    },
  });
});

test('a refused runner stop is asked again by the next record stop', async () => {
  const calls: string[] = [];
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        runRunner: async (_device: DeviceInfo, request: AppleScreenRecordingRunnerRequest) => {
          calls.push(request.kind);
          if (request.kind === 'stop' && calls.filter((call) => call === 'stop').length === 1) {
            throw new Error('macOS runner recordStop rejected');
          }
          return request.kind === 'start' ? coreDeviceRunnerStart : {};
        },
      },
      complete: async () => ({}),
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const handle = (
    await operations.screenRecordingStart(input({ scope: 'app' }))
  ).pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('macOS runner recordStop rejected');
  await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });
  expect(calls).toEqual(['start', 'stop', 'stop']);
});

test('runner cancellation after dispatch returns an uncertain exact handle for adoption', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel runner acquisition');
  const calls: string[] = [];
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        startSimulator: async () => {
          throw new Error('unused');
        },
        runRunner: async (_device, request) => {
          calls.push(request.kind);
          if (request.kind === 'start') controller.abort(reason);
          return request.kind === 'start' ? coreDeviceRunnerStart : {};
        },
      },
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: controller.signal,
  });

  const started = await operations.screenRecordingStart(input({ scope: 'app' }));

  expect(started.recoverableStartFailure).toMatchObject({
    reason: 'runner_recording_start_uncertain',
  });
  expect(calls).toEqual(['start']);
  await expect(started.pendingHandle.transfer().forceCleanup()).resolves.toEqual({
    status: 'cleaned',
  });
  expect(calls).toEqual(['start', 'stop', 'release']);
});

test('publishes a durable exact handle before reporting an uncertain runner start', async () => {
  const calls: string[] = [];
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        runRunner: async (_device, request) => {
          calls.push(request.kind);
          return request.kind === 'start'
            ? { ...coreDeviceRunnerStart, startState: 'uncertain' as const }
            : {};
        },
      },
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });

  const started = await operations.screenRecordingStart(input({ scope: 'app' }));

  expect(started.recoverableStartFailure).toMatchObject({
    reason: 'runner_recording_start_uncertain',
  });
  expect(started.envelope.descriptor).toMatchObject({
    version: 2,
    body: {
      startState: 'uncertain',
      recordingAuthority: coreDeviceRunnerStart.recordingAuthority,
    },
  });
  await expect(started.pendingHandle.transfer().forceCleanup()).resolves.toEqual({
    status: 'cleaned',
  });
  expect(calls).toEqual(['start', 'stop', 'release']);
});

test('refuses completion when the stable raw-file finalizer fails', async () => {
  let runnerPinReleased = false;
  const stop = vi.fn(async () => ({}));
  const release = vi.fn(async () => {
    if (runnerPinReleased) throw new Error('runner recording pin is already released');
    runnerPinReleased = true;
    return {};
  });
  const retrieve = vi.fn(async () => {
    runnerPinReleased = true;
  });
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        runRunner: async (_device, request) =>
          request.kind === 'start'
            ? coreDeviceRunnerStart
            : request.kind === 'stop'
              ? await stop()
              : await release(),
        retrieveRunnerRecording: retrieve,
      },
      complete: async () => {
        throw new Error('finalizer failed after runner stop');
      },
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(input({ scope: 'app' }));
  const handle = started.pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('finalizer failed after runner stop');
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });
  expect(stop).toHaveBeenCalledOnce();
  expect(retrieve).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
});

// A simctl process can exit while CoreSimulator still owns its recording slot.
// App recordings must finish through the runner's exact recording authority.
test('simulator app recording can finish, restart, and recover exact runner cleanup', async () => {
  const calls: string[] = [];
  let active = false;
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        runRunner: async (_device, request) => {
          calls.push(request.kind);
          if (request.kind === 'start') {
            assert.equal(active, false);
            active = true;
            return coreDeviceRunnerStart;
          }
          if (request.kind === 'stop') active = false;
          return {};
        },
        retrieveRunnerRecording: async () => {
          calls.push('retrieve');
        },
      },
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  for (let cycle = 0; cycle < 2; cycle++) {
    const started = await operations.screenRecordingStart(input({ scope: 'app' }));
    assert.equal((await started.pendingHandle.transfer().finish()).status, 'completed');
  }
  const abandoned = await operations.screenRecordingStart(input({ scope: 'app' }));
  await expect(
    operations.screenRecordingCleanup({ envelope: abandoned.envelope }),
  ).resolves.toMatchObject({ status: 'cleaned' });
  assert.equal(active, false);
  assert.deepEqual(calls, [
    'start',
    'stop',
    'retrieve',
    'start',
    'stop',
    'retrieve',
    'start',
    'stop',
    'release',
  ]);
});
