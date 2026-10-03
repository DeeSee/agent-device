import { expect, test, vi } from 'vitest';
import { completeAppleRecording } from './completion.ts';
import { appleRecordingHost } from './runtime.fixtures.ts';

test('explicitly hidden Apple recording publishes raw without trim or overlay work', async () => {
  const complete = vi.fn(async () => ({}));
  const snapshot = {
    backend: 'runner AVAssetWriter',
    outPath: '/tmp/capture.mp4',
    startedAt: 1,
    scope: 'app' as const,
    showTouches: false,
    recordOnlySession: false,
    gestureEvents: [],
    exportQuality: 'high' as const,
    requestedFps: 30,
    runnerStartedAtUptimeMs: 10,
  };
  await expect(
    completeAppleRecording({
      host: appleRecordingHost({ complete }),
      snapshot,
      targetLabel: 'iOS recording',
      stopObservation: { recorder: 'confirmed' },
    }),
  ).resolves.toMatchObject({
    status: 'completed',
    result: { showTouches: false },
  });
  expect(complete).toHaveBeenCalledWith(
    {
      outputPath: '/tmp/capture.mp4',
      showTouches: false,
      gestureEvents: [],
      requestedFps: 30,
      targetLabel: 'iOS recording',
    },
    undefined,
  );
});

test('raw completion cannot manufacture success before the stable-file boundary', async () => {
  const complete = vi.fn(async () => {
    throw new Error('recording file did not stabilize');
  });
  const snapshot = {
    backend: 'runner AVAssetWriter',
    outPath: '/tmp/capture.mp4',
    startedAt: 1,
    scope: 'app' as const,
    showTouches: false,
    recordOnlySession: false,
    gestureEvents: [],
  };

  await expect(
    completeAppleRecording({
      host: appleRecordingHost({ complete }),
      snapshot,
      targetLabel: 'iOS recording',
      stopObservation: { recorder: 'confirmed' },
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'recording file did not stabilize',
  });
});

test('ordinary Apple recording forwards overlay quality after raw retrieval', async () => {
  const complete = vi.fn(async () => ({}));
  const signal = new AbortController().signal;
  const snapshot = {
    backend: 'runner AVAssetWriter',
    outPath: '/tmp/capture.mp4',
    startedAt: 1,
    scope: 'app' as const,
    showTouches: true,
    recordOnlySession: false,
    gestureEvents: [{ kind: 'tap' as const, tMs: 1, x: 2, y: 3 }],
    exportQuality: 'high' as const,
    requestedFps: 30,
    runnerStartedAtUptimeMs: 10,
  };

  await expect(
    completeAppleRecording({
      host: appleRecordingHost({ complete }),
      snapshot,
      targetLabel: 'iOS recording',
      signal,
      stopObservation: { recorder: 'confirmed' },
    }),
  ).resolves.toMatchObject({
    status: 'completed',
    result: { showTouches: true },
  });
  expect(complete).toHaveBeenCalledWith(
    {
      outputPath: '/tmp/capture.mp4',
      showTouches: true,
      gestureEvents: snapshot.gestureEvents,
      exportQuality: 'high',
      requestedFps: 30,

      targetLabel: 'iOS recording',
    },
    signal,
  );
});

test('invalidated overlay request publishes raw with an explicit warning', async () => {
  const complete = vi.fn(async () => ({}));
  const snapshot = {
    backend: 'runner AVAssetWriter',
    outPath: '/tmp/capture.mp4',
    startedAt: 1,
    scope: 'app' as const,
    showTouches: true,
    recordOnlySession: false,
    gestureEvents: [],
    invalidatedReason: 'runner restarted',
    runnerStartedAtUptimeMs: 10,
  };

  await expect(
    completeAppleRecording({
      host: appleRecordingHost({ complete }),
      snapshot,
      targetLabel: 'iOS recording',
      stopObservation: { recorder: 'confirmed' },
    }),
  ).resolves.toMatchObject({
    status: 'completed',
    result: {
      showTouches: false,
      overlayWarning: 'overlay unavailable: runner restarted',
      stopObservation: { recorder: 'lost', why: 'owner-session-lost' },
    },
  });
  expect(complete).toHaveBeenCalledWith(
    {
      outputPath: '/tmp/capture.mp4',
      showTouches: false,
      gestureEvents: [],
      targetLabel: 'iOS recording',
    },
    undefined,
  );
});
