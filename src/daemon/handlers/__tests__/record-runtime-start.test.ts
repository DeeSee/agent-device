import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { makeRecordRuntimeHarness } from './record-runtime.fixtures.ts';

test('record start adopts the runtime pair and projects unchanged response metadata', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-', { appBundleId: 'com.example.app' });
  const outPath = path.join(mkdtempForTestSync('record-runtime-output-'), 'capture.mp4');

  const response = await harness.run(['start', outPath]);

  if (!response.ok) throw new Error(JSON.stringify(response.error));
  expect(response).toMatchObject({
    ok: true,
    data: {
      recording: 'started',
      outPath,
      recordingBackend: 'adb screenrecord',
      recordingScope: 'app',
      showTouches: true,
    },
  });
  expect(harness.runtime.start).toHaveBeenCalledOnce();
  expect(harness.sessionStore.get(harness.sessionName)?.screenRecording?.handle).toBe(
    harness.runtime.handle,
  );
});

test('record start preserves the requested path while the runtime receives the expanded native path', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-relative-output-');
  const cwd = mkdtempForTestSync('record-runtime-relative-output-cwd-');

  const response = await harness.run(['start', 'capture.mp4'], { cwd });

  expect(response).toMatchObject({ ok: true, data: { outPath: 'capture.mp4' } });
  expect(harness.runtime.start).toHaveBeenCalledWith(
    expect.objectContaining({ outputPath: path.join(cwd, 'capture.mp4') }),
  );
});

test('record start forwards the complete external XCTest selection into the Apple runtime', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-runner-selection-', {
    appBundleId: 'com.example.app',
  });

  await harness.run(['start', 'capture.mp4'], undefined, {
    flags: {
      iosXctestrunFile: '/artifacts/runner.xctestrun',
      iosXctestDerivedDataPath: '/private/run/derived',
      iosXctestEnvDir: '/private/run/env',
    },
  });

  expect(harness.runtime.start).toHaveBeenCalledWith(
    expect.objectContaining({
      iosXctestrunFile: '/artifacts/runner.xctestrun',
      iosXctestDerivedDataPath: '/private/run/derived',
      iosXctestEnvDir: '/private/run/env',
    }),
  );
});

test('uncertain start reports a typed failure after adopting its exact cleanup handle', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-uncertain-', {
    appBundleId: 'com.example.app',
    runtime: {
      recoverableStartFailure: {
        reason: 'runner_recording_start_uncertain',
        message: 'runner start outcome is uncertain',
      },
    },
  });

  const response = await harness.run(['start', 'capture.mp4']);

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      details: {
        reason: 'runner_recording_start_uncertain',
        recordingRecovery: 'stop-or-cleanup-exact-adopted-resource',
      },
    },
  });
  expect(harness.sessionStore.get(harness.sessionName)?.screenRecording?.handle).toBe(
    harness.runtime.handle,
  );
});

test.each(['linux', 'vega'] as const)(
  'record start on %s reports public unsupported guidance',
  async (platform) => {
    const harness = makeRecordRuntimeHarness(`record-runtime-${platform}-unsupported-`, {
      platform,
      runtime: {
        screenRecordingStartFact: {
          available: false,
          reason: 'unsupported-platform-leaf',
        },
      },
    });

    const response = await harness.run(['start', 'capture.mp4']);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'record is not supported on this device',
        hint: 'Select an Apple, Android, physical HarmonyOS, or web target that supports screen recording.',
        details: { reason: 'unsupported-platform-leaf' },
      },
    });
    expect(harness.runtime.start).not.toHaveBeenCalled();
  },
);
