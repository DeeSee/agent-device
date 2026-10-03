import { beforeEach, expect, test, vi } from 'vitest';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';

const video = vi.hoisted(() => ({
  container: vi.fn(async () => true),
  stable: vi.fn(async (_path: string, _options?: { signal?: AbortSignal }) => {}),
  playable: vi.fn(
    async (
      _path: string,
      _options?: { signal?: AbortSignal },
    ): Promise<import('@agent-device/capture-kit/recording-video').VideoInspection> => ({
      status: 'measured' as const,
      source: 'media-pts' as const,
      sampleCount: 3,
      mediaDurationMs: 100,
      firstPtsMs: 0,
      lastPtsMs: 100,
      maxInterSampleGapMs: 50,
      effectiveFps: 20,
    }),
  ),
}));
const telemetry = vi.hoisted(() => vi.fn(() => '/tmp/capture.telemetry.json'));
const processing = vi.hoisted(() => ({
  overlay: vi.fn(async () => {}),
}));
vi.mock('@agent-device/capture-kit/recording-video', () => ({
  hasVideoContainer: video.container,
  waitForStableFile: video.stable,
  waitForPlayableVideo: video.playable,
}));
vi.mock('@agent-device/capture-kit/recording-telemetry', () => ({
  persistRecordingTelemetry: telemetry,
}));
vi.mock('@agent-device/capture-kit/recording-overlay', () => ({
  getRecordingOverlaySupportWarning: () => undefined,
  overlayRecordingTouches: processing.overlay,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test('publishes raw completion without depending on the derivative stability gate', async () => {
  const result = await createScreenRecordingFinalizer().complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: false,
    gestureEvents: [],
    requestedFps: 30,
    targetLabel: 'test recording',
  });

  expect(video.stable).not.toHaveBeenCalled();
  expect(video.playable).not.toHaveBeenCalled();
  expect(result).toEqual({
    telemetryPath: '/tmp/capture.telemetry.json',
    supplemental: {
      mediaInspection: 'unavailable',
      telemetry: 'written',
    },
    warning: 'raw recording is ready; supplemental media inspection was not performed',
  });
});

test('keeps stable raw media terminal when telemetry persistence fails', async () => {
  telemetry.mockImplementationOnce(() => {
    throw new Error('telemetry storage unavailable');
  });

  await expect(
    createScreenRecordingFinalizer().complete({
      outputPath: '/tmp/capture.mp4',
      showTouches: false,
      gestureEvents: [],
      targetLabel: 'test recording',
    }),
  ).resolves.toMatchObject({
    supplemental: {
      mediaInspection: 'unavailable',
      telemetry: 'unavailable',
    },
    warning:
      'raw recording is ready; supplemental media inspection was not performed and telemetry is unavailable',
  });
});

test('refuses an invalid raw container before publishing telemetry or completion', async () => {
  video.container.mockResolvedValueOnce(false);

  await expect(
    createScreenRecordingFinalizer().complete({
      outputPath: '/tmp/capture.mp4',
      showTouches: false,
      gestureEvents: [],
      targetLabel: 'test recording',
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { retriable: true },
  });
  expect(telemetry).not.toHaveBeenCalled();
  expect(video.playable).not.toHaveBeenCalled();
});

test('keeps retrieved raw media terminal when supplemental finalization is canceled', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel recording finalization');
  controller.abort(reason);

  await expect(
    createScreenRecordingFinalizer().complete(
      {
        outputPath: '/tmp/capture.mp4',
        showTouches: false,
        gestureEvents: [],
        targetLabel: 'test recording',
      },
      controller.signal,
    ),
  ).resolves.toEqual({
    supplemental: {
      mediaInspection: 'unavailable',
      telemetry: 'unavailable',
    },
    warning:
      'raw recording is ready; supplemental media inspection was not performed and telemetry is unavailable',
  });

  expect(video.stable).not.toHaveBeenCalled();
  expect(video.playable).not.toHaveBeenCalled();
  expect(telemetry).not.toHaveBeenCalled();
});

test('finishes and commits a derivative once post-processing has begun', async () => {
  const controller = new AbortController();
  const reason = new Error('late cancellation');
  processing.overlay.mockImplementationOnce(async () => {
    controller.abort(reason);
  });

  await expect(
    createScreenRecordingFinalizer().complete(
      {
        outputPath: '/tmp/capture.mp4',
        showTouches: true,
        gestureEvents: [{ kind: 'tap', tMs: 10, x: 20, y: 30 }],

        targetLabel: 'test recording',
      },
      controller.signal,
    ),
  ).resolves.toMatchObject({ telemetryPath: '/tmp/capture.telemetry.json' });

  expect(telemetry).toHaveBeenCalledOnce();
  expect(processing.overlay).toHaveBeenCalledOnce();
  expect(video.playable.mock.calls.slice(1)).toEqual([['/tmp/capture.mp4', { signal: undefined }]]);
});

test('returns typed unavailable cadence without inventing achieved FPS', async () => {
  video.playable.mockResolvedValueOnce({
    status: 'unavailable',
    source: 'media-pts',
    reason: 'validator-unavailable',
  });

  await expect(
    createScreenRecordingFinalizer().complete({
      outputPath: '/tmp/capture.mp4',
      showTouches: true,
      gestureEvents: [],
      requestedFps: 30,
      targetLabel: 'test recording',
    }),
  ).resolves.toEqual({
    telemetryPath: '/tmp/capture.telemetry.json',
    cadence: {
      status: 'unavailable',
      source: 'media-pts',
      requestedFps: 30,
      reason: 'validator-unavailable',
    },
    supplemental: {
      mediaInspection: 'unavailable',
      telemetry: 'written',
    },
    warning: 'recording cadence unavailable: validator-unavailable',
  });
});

test('publishes cadence from the final transformed artifact', async () => {
  video.playable
    .mockResolvedValueOnce({
      status: 'measured',
      source: 'media-pts',
      sampleCount: 10,
      mediaDurationMs: 1_000,
      firstPtsMs: 0,
      lastPtsMs: 900,
      maxInterSampleGapMs: 100,
      effectiveFps: 10,
    })
    .mockResolvedValueOnce({
      status: 'measured',
      source: 'media-pts',
      sampleCount: 24,
      mediaDurationMs: 800,
      firstPtsMs: 0,
      lastPtsMs: 766.67,
      maxInterSampleGapMs: 33.34,
      effectiveFps: 30,
    });

  const result = await createScreenRecordingFinalizer().complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: true,
    gestureEvents: [{ kind: 'tap', tMs: 10, x: 20, y: 30 }],

    requestedFps: 30,
    targetLabel: 'test recording',
  });

  expect(processing.overlay).toHaveBeenCalledOnce();
  expect(result.cadence).toEqual({
    status: 'measured',
    source: 'media-pts',
    requestedFps: 30,
    sampleCount: 24,
    mediaDurationMs: 800,
    firstPtsMs: 0,
    lastPtsMs: 766.67,
    maxInterSampleGapMs: 33.34,
    effectiveFps: 30,
  });
});

test('names the retry and the escape for a recording that never became playable', async () => {
  video.playable.mockResolvedValueOnce({
    status: 'invalid',
    source: 'media-pts',
    reason: 'probe-failed',
  });

  await expect(
    createScreenRecordingFinalizer().complete({
      outputPath: '/tmp/capture.mp4',
      showTouches: true,
      gestureEvents: [],
      targetLabel: 'test recording',
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('was not finalized into a playable video'),
    details: {
      reason: 'recording-output-unplayable',
      retriable: true,
      hint: expect.stringContaining('close this session'),
    },
  });
});

test('#2707 reports a dropped overlay and keeps the raw when compositing throws', async () => {
  // overlay.ts verifies the composite and only renames it over the raw on success, so a compositor
  // that fails its own #2707 checks throws before any rename: the raw file survives and the caller
  // learns of the drop from the response, not from a black or shrunken file. This locks the
  // finalizer's drop-and-report contract; the preset/black checks themselves are proven by the
  // AGENT_DEVICE_RECORDING_E2E device lane, which is red against the old 480px preset.
  processing.overlay.mockRejectedValueOnce(
    new Error(
      'Touch overlay export produced an all-black track while the raw capture had visible content.',
    ),
  );

  const result = await createScreenRecordingFinalizer().complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: true,
    gestureEvents: [{ kind: 'tap', tMs: 500, x: 10, y: 20 }],
    targetLabel: 'test recording',
  });

  expect(result).toMatchObject({
    telemetryPath: '/tmp/capture.telemetry.json',
    overlayWarning: expect.stringContaining('failed to overlay recording touches'),
  });
});

test('#2707 reports a warning when a composited recording turns unplayable after burn-in', async () => {
  // Narrower than it looks: overlay.ts confirms the composite playable before renaming, so this only
  // models the post-rename TOCTOU where the file the raw was replaced with goes unplayable. The raw
  // is already overwritten here, so the finalizer can report but not restore — it must not exit 0
  // silently, which the pre-rename probe and the Swift check already prevent for ordinary failures.
  processing.overlay.mockImplementationOnce(async () => {
    video.playable.mockResolvedValueOnce({
      status: 'invalid',
      source: 'media-pts',
      reason: 'probe-failed',
    });
  });

  const result = await createScreenRecordingFinalizer().complete({
    outputPath: '/tmp/capture.mp4',
    showTouches: true,
    gestureEvents: [{ kind: 'tap', tMs: 500, x: 10, y: 20 }],
    targetLabel: 'test recording',
  });

  expect(result).toMatchObject({
    overlayWarning: expect.stringContaining('failed to overlay recording touches'),
  });
});

test('sniffs a collected copy without spawning the validator, and refuses one with no container', async () => {
  const validatorCalls = video.playable.mock.calls.length;
  await expect(
    createScreenRecordingFinalizer().sniff({ outputPath: '/tmp/capture.collected.mp4' }),
  ).resolves.toBeUndefined();
  video.container.mockResolvedValueOnce(false);

  await expect(
    createScreenRecordingFinalizer().sniff({ outputPath: '/tmp/capture.collected.mp4' }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'recording-output-unplayable', retriable: true },
  });
  expect(video.playable.mock.calls.length).toBe(validatorCalls);
});
