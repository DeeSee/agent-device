import { AppError } from '@agent-device/kernel/errors';
import { RECORDING_OUTPUT_UNPLAYABLE_REASON } from '@agent-device/contracts/screen-recording-runtime';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import {
  getRecordingOverlaySupportWarning,
  overlayRecordingTouches,
} from '@agent-device/capture-kit/recording-overlay';
import { persistRecordingTelemetry } from '@agent-device/capture-kit/recording-telemetry';
import {
  hasVideoContainer,
  type VideoInspection,
  waitForPlayableVideo,
  waitForStableFile,
} from '@agent-device/capture-kit/recording-video';

export function createScreenRecordingFinalizer(): ScreenRecordingRuntimeHost['finalize'] {
  return Object.freeze({ sniff: sniffRecording, complete: finalizeScreenRecording });
}

async function sniffRecording(input: Readonly<{ outputPath: string }>): Promise<void> {
  if (!(await hasVideoContainer(input.outputPath))) throw unplayableRecording(input.outputPath);
}

async function finalizeScreenRecording(
  input: Parameters<ScreenRecordingRuntimeHost['finalize']['complete']>[0],
  signal?: AbortSignal,
) {
  if (!input.showTouches) return await finalizeRawRecording(input, signal);
  signal?.throwIfAborted();
  await waitForStableFile(input.outputPath, { signal });
  let finalInspection = await requirePlayableInspection(input.outputPath, signal);
  signal?.throwIfAborted();
  const telemetryPath = persistRecordingTelemetry({
    recording: { outPath: input.outputPath, gestureEvents: [...input.gestureEvents] },
  });
  let overlayWarning: string | undefined;
  if (input.showTouches && input.gestureEvents.length > 0) {
    const overlay = await overlayTouches(input, telemetryPath);
    finalInspection = overlay.inspection ?? finalInspection;
    overlayWarning = overlay.overlayWarning;
  }
  return {
    telemetryPath,
    cadence: cadenceWithRequest(finalInspection, input.requestedFps),
    supplemental: {
      mediaInspection: finalInspection.status,
      telemetry: 'written' as const,
    },
    ...(finalInspection.status === 'unavailable'
      ? { warning: `recording cadence unavailable: ${finalInspection.reason}` }
      : {}),
    ...(overlayWarning === undefined ? {} : { overlayWarning }),
  };
}

async function finalizeRawRecording(
  input: Parameters<ScreenRecordingRuntimeHost['finalize']['complete']>[0],
  signal?: AbortSignal,
) {
  // Raw completion still requires a video container; decoder inspection is supplementary.
  await sniffRecording(input);
  const telemetry = signal?.aborted ? undefined : tryPersistRawTelemetry(input);
  const telemetryStatus: 'written' | 'unavailable' = telemetry ? 'written' : 'unavailable';
  return {
    ...(telemetry ? { telemetryPath: telemetry } : {}),
    supplemental: {
      mediaInspection: 'unavailable' as const,
      telemetry: telemetryStatus,
    },
    warning:
      telemetryStatus === 'written'
        ? 'raw recording is ready; supplemental media inspection was not performed'
        : 'raw recording is ready; supplemental media inspection was not performed and telemetry is unavailable',
  };
}

function tryPersistRawTelemetry(
  input: Parameters<ScreenRecordingRuntimeHost['finalize']['complete']>[0],
): string | undefined {
  try {
    return persistRecordingTelemetry({
      recording: {
        outPath: input.outputPath,
        gestureEvents: [...input.gestureEvents],
      },
    });
  } catch {
    return undefined;
  }
}

async function requirePlayableInspection(
  outputPath: string,
  signal?: AbortSignal,
): Promise<VideoInspection> {
  const inspection = await waitForPlayableVideo(outputPath, { signal });
  if (inspection.status === 'invalid') {
    throw unplayableRecording(outputPath);
  }
  return inspection;
}

function cadenceWithRequest(
  inspection: VideoInspection,
  requestedFps: number | undefined,
): VideoInspection {
  return Object.freeze({
    ...inspection,
    ...(requestedFps === undefined ? {} : { requestedFps }),
  });
}

async function overlayTouches(
  input: Parameters<ScreenRecordingRuntimeHost['finalize']['complete']>[0],
  telemetryPath: string,
) {
  const warning = getRecordingOverlaySupportWarning();
  if (warning) return { overlayWarning: warning };
  try {
    await overlayRecordingTouches({
      videoPath: input.outputPath,
      telemetryPath,
      exportQuality: input.exportQuality,
      targetLabel: input.targetLabel,
    });
    return { inspection: await requirePlayableInspection(input.outputPath) };
  } catch (error) {
    return {
      overlayWarning: `failed to overlay recording touches: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function unplayableRecording(outputPath: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `recording was not finalized into a playable video: ${outputPath}`,
    {
      reason: RECORDING_OUTPUT_UNPLAYABLE_REASON,
      retriable: true,
      hint:
        'Run record stop again: a recorder that is still finalizing its file is playable on the ' +
        'next stop, and the recording keeps its evidence either way. If the recorder died before ' +
        'writing a video, close this session to release the device and record again.',
    },
  );
}
