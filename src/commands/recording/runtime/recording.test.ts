import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import type { ArtifactAdapter, FileInputRef } from '../../../io.ts';
import {
  createAgentDevice,
  localCommandPolicy,
  restrictedCommandPolicy,
} from '../../../runtime.ts';

const artifacts = {
  resolveInput: async (ref: FileInputRef) => ({
    path: ref.kind === 'path' ? ref.path : `/tmp/uploaded/${ref.id}.app`,
    cleanup: ref.kind === 'uploadedArtifact' ? async () => {} : undefined,
  }),
  reserveOutput: async (ref, options) => ({
    path: ref?.kind === 'path' ? ref.path : `/tmp/${options.field}${options.ext}`,
    visibility: options.visibility ?? 'client-visible',
    publish: async () => undefined,
  }),
  createTempFile: async (options) => ({
    path: `/tmp/${options.prefix}${options.ext}`,
    visibility: 'internal',
    cleanup: async () => {},
  }),
} satisfies ArtifactAdapter;

test('record and trace runtime commands call typed backend lifecycle primitives', async () => {
  const calls: unknown[] = [];
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      startRecording: async (_context, options) => {
        calls.push({ command: 'startRecording', options });
        return { path: options?.outPath ?? '/tmp/recording.mp4' };
      },
      stopTrace: async (_context, options) => {
        calls.push({ command: 'stopTrace', options });
        return { outPath: options?.outPath ?? '/tmp/trace.log' };
      },
    },
    artifacts,
    policy: localCommandPolicy(),
  });

  const recording = await device.recording.record({
    action: 'start',
    out: { kind: 'path', path: '/tmp/out.mp4' },
    fps: 30,
    quality: 'high',
    hideTouches: true,
  });
  assert.equal(recording.kind, 'recordingStarted');

  const trace = await device.recording.trace({
    action: 'stop',
    out: { kind: 'path', path: '/tmp/out.trace' },
  });
  assert.equal(trace.kind, 'traceStopped');

  assert.deepEqual(calls, [
    {
      command: 'startRecording',
      options: {
        outPath: '/tmp/out.mp4',
        fps: 30,
        quality: 'high',
        showTouches: false,
      },
    },
    { command: 'stopTrace', options: { outPath: '/tmp/out.trace' } },
  ]);
});

test('record output paths are policy-gated', async () => {
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      startRecording: async () => ({ path: '/tmp/recording.mp4' }),
    },
    artifacts,
    policy: restrictedCommandPolicy(),
  });

  await assert.rejects(
    () =>
      device.recording.record({
        action: 'start',
        out: { kind: 'path', path: '/tmp/out.mp4' },
      }),
    /Local output paths are not allowed/,
  );
});

test('record keeps successful reserved outputs available after publish', async () => {
  let cleanupCalled = false;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      startRecording: async (_context, options) => ({ path: options?.outPath }),
    },
    artifacts: {
      ...artifacts,
      reserveOutput: async (_ref, options) => ({
        path: `/tmp/${options.field}${options.ext}`,
        visibility: options.visibility ?? 'client-visible',
        publish: async () => ({
          kind: 'artifact',
          field: options.field,
          artifactType: options.artifactType,
          artifactId: 'recording-1',
          fileName: 'recording.mp4',
        }),
        cleanup: async () => {
          cleanupCalled = true;
        },
      }),
    },
    policy: restrictedCommandPolicy(),
  });

  const result = await device.recording.record({
    action: 'start',
    out: { kind: 'downloadableArtifact', fileName: 'recording.mp4' },
  });

  assert.equal(result.artifact?.kind, 'artifact');
  assert.equal(cleanupCalled, false);
});

test('record stop keeps terminal raw output when artifact publication fails', async () => {
  let cleanupCalled = false;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      stopRecording: async (_context, options) => ({ path: options?.outPath }),
    },
    artifacts: {
      ...artifacts,
      reserveOutput: async (_ref, options) => ({
        path: `/tmp/${options.field}${options.ext}`,
        visibility: options.visibility ?? 'client-visible',
        publicationFailurePreservesOutput: true,
        publish: async () => {
          throw new Error('artifact publication unavailable');
        },
        cleanup: async () => {
          cleanupCalled = true;
        },
      }),
    },
    policy: restrictedCommandPolicy(),
  });

  const result = await device.recording.record({
    action: 'stop',
    out: { kind: 'downloadableArtifact', fileName: 'recording.mp4' },
    hideTouches: true,
  });

  assert.equal(result.kind, 'recordingStopped');
  assert.equal(result.path, '/tmp/path.mp4');
  assert.deepEqual(result.artifactPublication, {
    status: 'unavailable',
    reason: 'adapter-failed',
  });
  assert.equal(cleanupCalled, false);
});

test('record stop refuses a destructive publication adapter before backend effects', async () => {
  let cleanupCalled = false;
  const stopRecording = vi.fn(async () => ({ path: '/tmp/path.mp4' }));
  const publish = vi.fn(async () => undefined);
  const device = createAgentDevice({
    backend: { platform: 'ios', stopRecording },
    artifacts: {
      ...artifacts,
      reserveOutput: async (_ref, options) => ({
        path: `/tmp/${options.field}${options.ext}`,
        visibility: options.visibility ?? 'client-visible',
        publish,
        cleanup: async () => {
          cleanupCalled = true;
        },
      }),
    },
    policy: restrictedCommandPolicy(),
  });

  await expect(
    device.recording.record({
      action: 'stop',
      out: { kind: 'downloadableArtifact', fileName: 'recording.mp4' },
      hideTouches: true,
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  expect(stopRecording).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(cleanupCalled).toBe(true);
});
