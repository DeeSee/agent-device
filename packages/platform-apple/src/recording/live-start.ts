import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { CleanupOutcome, FinishOutcome } from '@agent-device/contracts/durable-resource';
import type {
  ScreenRecordingStartInput,
  ScreenRecordingLiveSnapshot,
  ScreenRecordingLiveHandle,
  ScreenRecordingCompletion,
} from '@agent-device/contracts/screen-recording-runtime';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { createScreenRecordingLiveHandle } from '@agent-device/capture-kit';
import {
  createAppleRecordingEnvelope,
  type AppleRecordingDescriptor,
  type AppleScreenRecordingOperationHost,
} from './recovery.ts';
export type AppleRecordingStartParams = Readonly<{
  host: AppleScreenRecordingOperationHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  signal: AbortSignal;
}>;

export function startResult(params: {
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  descriptor: AppleRecordingDescriptor;
  snapshot: ScreenRecordingLiveSnapshot;
  finish(
    snapshot: ScreenRecordingLiveSnapshot,
    progress?: Parameters<ScreenRecordingLiveHandle['finish']>[0],
    signal?: AbortSignal,
  ): Promise<FinishOutcome<ScreenRecordingCompletion>>;
  cleanup(): Promise<CleanupOutcome>;
  recoverableStartFailure?: Readonly<{
    reason: 'runner_recording_start_uncertain';
    message: string;
  }>;
}) {
  const { device, owner, input, descriptor, snapshot, finish, cleanup, recoverableStartFailure } =
    params;
  const handle = createScreenRecordingLiveHandle(snapshot, {
    finish,
    forceCleanup: cleanup,
  });
  return Object.freeze({
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createAppleRecordingEnvelope({ device, owner, input, descriptor }),
    ...(recoverableStartFailure ? { recoverableStartFailure } : {}),
  });
}

export function snapshot(
  input: ScreenRecordingStartInput,
  backend: string,
  timing: Readonly<{
    recorderStartUptimeMs?: number;
    runnerSessionId?: string;
  }> = {},
  clockAnchor?: Readonly<{ wallClockAtMs: number; uptimeMs: number }>,
): ScreenRecordingLiveSnapshot {
  const startedAt = Date.now();
  return Object.freeze({
    backend,
    outPath: input.outputPath,
    ...(input.clientOutputPath === undefined ? {} : { clientOutPath: input.clientOutputPath }),
    startedAt,
    scope: input.scope,
    showTouches: input.showTouches,
    recordOnlySession: input.recordOnlySession,
    ...(input.activeSessionApp === undefined ? {} : { activeSessionApp: input.activeSessionApp }),
    ...(input.exportQuality === undefined ? {} : { exportQuality: input.exportQuality }),
    ...(input.fps === undefined ? {} : { requestedFps: input.fps }),
    gestureEvents: [],
    ...(clockAnchor === undefined
      ? {}
      : {
          gestureClockOriginAtMs: clockAnchor.wallClockAtMs,
          gestureClockOriginUptimeMs: clockAnchor.uptimeMs,
        }),
    ...(timing.recorderStartUptimeMs === undefined
      ? {}
      : {
          gestureClockOriginAtMs: startedAt,
          gestureClockOriginUptimeMs: timing.recorderStartUptimeMs,
          runnerStartedAtUptimeMs: timing.recorderStartUptimeMs,
        }),
    ...(timing.runnerSessionId === undefined ? {} : { runnerSessionId: timing.runnerSessionId }),
  });
}
