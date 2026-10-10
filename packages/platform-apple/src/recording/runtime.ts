import { startAppleRunnerRecording } from './runner-runtime.ts';
import { startResult, snapshot, type AppleRecordingStartParams } from './live-start.ts';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import type { HostCommandResult } from '@agent-device/contracts/platform-runtime-host';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import {
  RECORDING_OUTPUT_UNPLAYABLE_REASON,
  type ScreenRecordingLiveHandle,
  type ScreenRecordingLiveSnapshot,
  type ScreenRecordingRuntimeOperations,
  type ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';
import { createScreenRecordingLiveHandle } from '@agent-device/capture-kit';
import {
  nativeRecordingPath,
  type RecorderStop,
  stopAndExportScreenRecording,
} from '@agent-device/capture-kit/recording-stop-sequence';
import { finalizeAppleRecordingFromCollected } from './completion.ts';
import {
  cleanupAppleRecording,
  reattachAppleRecording,
  simulatorExportCoordinates,
  type AppleScreenRecordingOperationHost,
  type AppleSimulatorExportRestore,
} from './recovery.ts';
import { validateAppleSimulatorRecording } from './validation.ts';

const SIMULATOR_TARGET_LABEL = 'iOS recording';
const SIMULATOR_BACKEND_LABEL = 'simctl recordVideo';

export function appleScreenRecordingFacts(device: DeviceInfo) {
  if (device.appleOs === 'watchos')
    return unavailable('unsupported-platform-leaf', 'watchOS recording is not supported.');
  if (
    isIosFamily(device) &&
    device.kind === 'device' &&
    device.iosPhysicalDeviceBackend === 'xctest'
  ) {
    return unavailable(
      'unsupported-device-backend',
      'This command requires a CoreDevice-backed physical iOS device. The selected XCTest backend supports open, close, interactions, snapshots, and screenshots.',
    );
  }
  return Object.freeze({ available: true } as const);
}

export function createAppleScreenRecordingOperations(params: {
  host: AppleScreenRecordingOperationHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  signal: AbortSignal;
}): ScreenRecordingRuntimeOperations {
  const { host, device, owner, signal } = params;
  return Object.freeze({
    screenRecordingStart: async (input) =>
      await startAppleRecording({ host, device, owner, input, signal }),
    screenRecordingReattach: async (input) => {
      const reattached = await reattachAppleRecording({ host, device, envelope: input.envelope });
      return reattached.status === 'restore-export'
        ? { status: 'active', handle: simulatorExportHandle({ host, restored: reattached }) }
        : reattached;
    },
    screenRecordingCleanup: async (input) =>
      await cleanupAppleRecording(
        host,
        device,
        input.envelope.descriptor.body,
        input.envelope.sessionId,
      ),
  } satisfies ScreenRecordingRuntimeOperations);
}

async function startAppleRecording(params: AppleRecordingStartParams) {
  params.signal.throwIfAborted();
  validateAppleRecordingRequest(params.device, params.input);
  await validateAppleSimulatorRecording(
    params.device,
    params.input,
    params.host.screenRecording.apple.isRunnerBundleId,
  );
  const availability = await params.host.screenRecording.apple.availability(params.device);
  return params.device.kind === 'simulator' &&
    (params.input.scope !== 'app' ||
      (availability.available && availability.appRecordingBackend === 'simulator'))
    ? await startAppleSimulatorRecording(params)
    : await startAppleRunnerRecording(params);
}

async function startAppleSimulatorRecording(params: AppleRecordingStartParams) {
  const { host, device, owner, input, signal } = params;
  const clockAnchor = input.activeSessionApp
    ? await host.screenRecording.apple.captureClockAnchor(
        device,
        input.activeSessionApp.bundleId,
        signal,
      )
    : undefined;
  // The recorder owns its own file and the export is produced from a copy of it (ADR 0024 2.3), so a
  // stop that fails midway cannot leave the caller's path holding bytes the next attempt has to guess
  // about. `simctl` is told where to write; the caller's path is written once, from the copy.
  const nativePath = nativeRecordingPath(input.outputPath);
  await host.screenRecording.outputs.prepare(nativePath);
  const nativeProcess = await host.screenRecording.apple.startSimulator(device, nativePath, signal);
  const processes = nativeProcess.markers;
  if (!processes || processes.length === 0) {
    await settleAppleSimulatorProcess(nativeProcess).catch(() => {});
    throw new Error('simctl recordVideo did not expose durable process identity');
  }
  try {
    signal.throwIfAborted();
    host.screenRecording.ownedProcesses.replace(
      { kind: 'session', sessionId: input.sessionId },
      processes.map((process) => ({ ...process, purpose: 'simctl-screen-recording' })),
    );
  } catch (error) {
    try {
      host.screenRecording.ownedProcesses.clear({ kind: 'session', sessionId: input.sessionId });
    } catch {
      // Preserve the spawn/publication error; startup cleanup still has the process handle.
    }
    await settleAppleSimulatorProcess(nativeProcess).catch(() => {});
    throw error;
  }
  // The exit stays in scope because it is the one thing that explains an unreadable file: naming it
  // turns a permanent condition into a way out instead of a retry loop on the same bytes.
  let recorderExit: string | undefined;
  let recorderResult: HostCommandResult | undefined;
  const stopSimulatorRecorder = async (): Promise<RecorderStop> => {
    // An exited recorder is an observation about the recorder, not about the export: simctl wrote
    // whatever it wrote, and the playability rule is what answers whether that is a video
    // (ADR 0024 2.2). Refusing by exit code alone threw away a finished recording and left a retry
    // that could only re-read the same settled exit, so the exit is disclosed and collection proceeds.
    await nativeProcess.terminate();
    const result = await nativeProcess.wait;
    recorderResult = result;
    recorderExit = describeSimctlRecorderExit(result);
    host.screenRecording.ownedProcesses.clear({ kind: 'session', sessionId: input.sessionId });
    return {
      observation: { recorder: 'confirmed' },
      ...(recorderExit === undefined
        ? {}
        : {
            warning: `${recorderExit} before record stop; the video covers only what the recorder wrote before it stopped.`,
          }),
    };
  };
  const startedSnapshot = snapshot(input, SIMULATOR_BACKEND_LABEL, {}, clockAnchor);
  return startResult({
    device,
    owner,
    input,
    descriptor: {
      backend: 'simctl',
      outputPath: nativePath,
      processes,
      recording: simulatorExportCoordinates(startedSnapshot),
    },
    snapshot: startedSnapshot,
    finish: (current, progress, finishSignal) =>
      stopAndExportScreenRecording({
        snapshot: current,
        progress,
        steps: {
          stop: stopSimulatorRecorder,
          collect: async (collectedPath) => {
            try {
              await collectSimulatorRecording(host, nativePath, collectedPath);
            } catch (collectError) {
              throw recorderExitEndedTheRecording(collectError, recorderExit, recorderResult);
            }
          },
          finalize: async ({ collectedPath, exportPath }) => {
            try {
              return await finalizeAppleRecordingFromCollected({
                host,
                snapshot: current,
                targetLabel: SIMULATOR_TARGET_LABEL,
                collectedPath,
                exportPath,
                nativePath,
                signal: finishSignal,
              });
            } catch (exportError) {
              throw recorderExitEndedTheRecording(exportError, recorderExit, recorderResult);
            }
          },
          discard: async (collectedPath) => {
            await host.screenRecording.outputs.remove(collectedPath);
          },
        },
      }),
    cleanup: async () => {
      const result = await cleanupAppleSimulatorProcess(nativeProcess);
      if (result.status === 'cleaned' || result.status === 'already-missing') {
        host.screenRecording.ownedProcesses.clear({
          kind: 'session',
          sessionId: input.sessionId,
        });
      }
      return result;
    },
  });
}

/**
 * The stop a `simctl` recording gets when its recorder died with its daemon. There is no recorder left
 * to signal and no gesture event left to burn in, and every other step is the one the first stop would
 * have run — including which of them are still owed, which the shared sequence decides from the
 * checkpoints the first attempt journaled.
 */
function simulatorExportHandle(
  params: Readonly<{
    host: AppleScreenRecordingOperationHost;
    restored: AppleSimulatorExportRestore;
  }>,
): ScreenRecordingLiveHandle {
  const {
    host,
    restored: { recording, nativePath, cleanup },
  } = params;
  const snapshot: ScreenRecordingLiveSnapshot = Object.freeze({
    ...recording,
    backend: SIMULATOR_BACKEND_LABEL,
    gestureEvents: [],
  });
  return createScreenRecordingLiveHandle(snapshot, {
    finish: (current, progress, finishSignal) =>
      stopAndExportScreenRecording({
        snapshot: current,
        progress,
        steps: {
          stop: async () => ({
            observation: { recorder: 'confirmed' as const },
            warning:
              'simctl recordVideo had already ended when record stop reattached to it; ' +
              'the video covers only what the recorder wrote before it stopped.',
          }),
          collect: async (collectedPath) => {
            await collectSimulatorRecording(host, nativePath, collectedPath);
          },
          finalize: async ({ collectedPath, exportPath }) =>
            await finalizeAppleRecordingFromCollected({
              host,
              snapshot: current,
              targetLabel: SIMULATOR_TARGET_LABEL,
              collectedPath,
              exportPath,
              nativePath,
              signal: finishSignal,
              ...(recording.showTouches
                ? {
                    overlayUnavailable:
                      'the daemon that held the touch events ended before record stop',
                  }
                : {}),
            }),
          discard: async (collectedPath) => {
            await host.screenRecording.outputs.remove(collectedPath);
          },
        },
      }),
    forceCleanup: async () => await cleanup(),
  });
}

async function collectSimulatorRecording(
  host: AppleScreenRecordingOperationHost,
  nativePath: string,
  collectedPath: string,
): Promise<void> {
  // The copy gets the container sniff before it is checkpointed; the full playability verdict
  // runs once, on the export `finalize` writes from it.
  await host.screenRecording.outputs.copy({ from: nativePath, to: collectedPath });
  await host.screenRecording.finalize.sniff({ outputPath: collectedPath });
}

function describeSimctlRecorderExit(result: HostCommandResult): string | undefined {
  // A termination record stop asked for comes back with the signal still attached and the exit code
  // normalized to 0 by the host, so checking the signal first would blame the recorder for our own
  // SIGTERM escalation.
  if (result.exitCode === 0) return undefined;
  return result.signal
    ? `simctl recordVideo was killed by ${result.signal}`
    : `simctl recordVideo exited with code ${result.exitCode}`;
}

// An unreadable file is the one export failure the recorder's exit explains: the next `record stop`
// re-reads the same settled exit and the same bytes, so it names the exit and the way out. Anything
// else the export path raised keeps its own verdict — a telemetry or transport failure a retry can fix
// must not be told to close the session.
function recorderExitEndedTheRecording(
  exportError: unknown,
  exit: string | undefined,
  result: HostCommandResult | undefined,
): unknown {
  const original = asAppError(exportError, 'COMMAND_FAILED');
  if (exit === undefined || result === undefined) return exportError;
  if (original.details?.reason !== RECORDING_OUTPUT_UNPLAYABLE_REASON) return exportError;
  return new AppError(
    original.code,
    `${original.message}; ${exit}`,
    execFailureDetails(result, {
      ...(original.details ?? {}),
      ...(result.signal === undefined ? {} : { signal: result.signal }),
      retriable: false,
      hint:
        'The recorder exited before record stop, so the next record stop reads the same file. ' +
        'Close this session to release the device, then record again.',
    }),
  );
}

async function settleAppleSimulatorProcess(
  nativeProcess: Awaited<ReturnType<ScreenRecordingRuntimeHost['apple']['startSimulator']>>,
) {
  await nativeProcess.terminate();
  return await nativeProcess.wait;
}

async function cleanupAppleSimulatorProcess(
  nativeProcess: Awaited<ReturnType<ScreenRecordingRuntimeHost['apple']['startSimulator']>>,
): Promise<CleanupOutcome> {
  try {
    await settleAppleSimulatorProcess(nativeProcess);
    return { status: 'cleaned' };
  } catch (error) {
    return {
      status: 'cleanup-pending',
      reason: 'transport-failed',
      message: error instanceof Error ? error.message : 'Apple simulator cleanup failed',
    };
  }
}

function validateAppleRecordingRequest(device: DeviceInfo, input: ScreenRecordingStartInput): void {
  if (device.kind === 'simulator' && input.fps !== undefined) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Apple simulator recording does not support a requested FPS.',
      {
        reason: 'apple-simulator-recording-fps-unsupported',
        hint: 'Remove --fps. The result reports cadence measured from the encoded movie.',
      },
    );
  }
}

function unavailable(
  reason: 'unsupported-platform-leaf' | 'unsupported-device-backend',
  hint: string,
) {
  return Object.freeze({ available: false, reason, hint } as const);
}
