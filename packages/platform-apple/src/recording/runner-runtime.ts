import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { asAppError } from '@agent-device/kernel/errors';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import { completeAppleRecording as completion } from './completion.ts';
import { startResult, snapshot, type AppleRecordingStartParams } from './live-start.ts';
export async function startAppleRunnerRecording(params: AppleRecordingStartParams) {
  const { host, device, owner, input, signal } = params;
  const appBundleId = input.activeSessionApp?.bundleId;
  if (!appBundleId) {
    throw new TypeError('Apple runner recording requires an active app session identity');
  }
  await host.screenRecording.outputs.prepare(input.outputPath);
  const result = await host.screenRecording.apple.runRunner(
    device,
    runnerRecordingStartRequest(appBundleId, input),
    signal,
  );
  if (!result.recordingAuthority || !result.runnerAuthority || !result.startState) {
    throw new Error('Apple runner recording did not expose durable session ownership');
  }
  const recordingAuthority = result.recordingAuthority;
  const runnerOwnership = {
    runnerAuthority: result.runnerAuthority,
    recordingAuthority,
  } as const;
  let runnerStop: Promise<void> | undefined;
  // A stop the runner refused has to be asked again by the next `record stop`, exactly as the live
  // handle re-drives a refused finish; only an in-flight or completed stop stays shared.
  let runnerSettled = false;
  let runnerSettlement: Promise<void> | undefined;
  const stopRunner = (signal?: AbortSignal) => {
    runnerStop ??= runAppleRecordingOperation(() =>
      host.screenRecording.apple
        .runRunner(device, { kind: 'stop', appBundleId, ...runnerOwnership }, signal)
        .then(() => undefined),
    ).catch((error: unknown) => {
      runnerStop = undefined;
      throw error;
    });
    return runnerStop;
  };
  const settleRunner = (operation: () => Promise<unknown>) => {
    if (runnerSettled) return Promise.resolve();
    if (runnerSettlement) return runnerSettlement;
    const pending = runAppleRecordingOperation(operation)
      .then(() => {
        runnerSettled = true;
      })
      .finally(() => {
        if (!runnerSettled && runnerSettlement === pending) runnerSettlement = undefined;
      });
    runnerSettlement = pending;
    return pending;
  };
  const releaseRunner = (reason: 'retrieved' | 'abandoned') =>
    settleRunner(() =>
      host.screenRecording.apple.runRunner(device, {
        kind: 'release',
        ...runnerOwnership,
        reason,
      }),
    );
  const abandonRunner = async () => {
    await stopRunner();
    await releaseRunner('abandoned');
  };
  if (!runnerDescriptorMatchesDevice(device, recordingAuthority.remotePath)) {
    await abandonRunner().catch(() => {});
    throw new Error('Apple runner recording did not expose coherent durable media ownership');
  }
  const startState = signal.aborted ? 'uncertain' : result.startState;
  return startResult({
    device,
    owner,
    input,
    descriptor: {
      backend: 'runner',
      outputPath: input.outputPath,
      appBundleId,
      ...runnerOwnership,
      startState,
    },
    snapshot: snapshot(input, 'runner AVAssetWriter', {
      ...result,
      runnerSessionId: recordingAuthority.runnerSessionId,
    }),
    finish: async (current, _progress, finishSignal) => {
      await stopRunner(finishSignal);
      if (recordingAuthority.remotePath !== undefined) {
        await settleRunner(() =>
          host.screenRecording.apple.retrieveRunnerRecording(
            device,
            runnerOwnership.runnerAuthority,
            recordingAuthority,
            current.outPath,
            finishSignal,
          ),
        );
      } else {
        await releaseRunner('retrieved');
      }
      return await completion({
        host,
        snapshot: current,
        signal: finishSignal,
        targetLabel: device.appleOs === 'macos' ? 'macOS recording' : 'iOS recording',
        stopObservation: { recorder: 'confirmed' },
        // The runner wrote its recording to the device and the stop RPC was acknowledged, so the
        // retrieved file on the device is safe to retire; nothing removes it here (ADR 0024 2.3).
        ...(recordingAuthority.remotePath === undefined
          ? {}
          : { nativePathDisposition: 'retirable' as const }),
      });
    },
    cleanup: async () => {
      await abandonRunner();
      return { status: 'cleaned' } as const;
    },
    ...(startState === 'uncertain'
      ? {
          recoverableStartFailure: {
            reason: 'runner_recording_start_uncertain' as const,
            message: 'Apple runner recording start is uncertain; exact stop or cleanup is required',
          },
        }
      : {}),
  });
}

async function runAppleRecordingOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw asAppError(error, 'COMMAND_FAILED');
  }
}

function runnerDescriptorMatchesDevice(
  device: DeviceInfo,
  remotePath: string | undefined,
): boolean {
  if (device.appleOs === 'macos') return remotePath === undefined;
  if (!isIosFamily(device)) return remotePath === undefined;
  return remotePath !== undefined && /^tmp\/agent-device-recording-\d+\.mp4$/.test(remotePath);
}

function runnerRecordingStartRequest(appBundleId: string, input: ScreenRecordingStartInput) {
  return {
    kind: 'start' as const,
    appBundleId,
    outputPath: input.outputPath,
    ...(input.fps === undefined ? {} : { fps: input.fps }),
    ...(input.iosXctestrunFile === undefined ? {} : { iosXctestrunFile: input.iosXctestrunFile }),
    ...(input.iosXctestDerivedDataPath === undefined
      ? {}
      : { iosXctestDerivedDataPath: input.iosXctestDerivedDataPath }),
    ...(input.iosXctestEnvDir === undefined ? {} : { iosXctestEnvDir: input.iosXctestEnvDir }),
  };
}
