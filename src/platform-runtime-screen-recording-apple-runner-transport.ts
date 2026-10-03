import { loadAppleRunnerRecordingOperations } from '@agent-device/platform-apple/runner/recording';
import path from 'node:path';
import type { ManagedProcessOwnership } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { createScopedProvider } from '@agent-device/kernel/scoped-provider';
import type { AppleRunnerRecordingAuthority as RunnerRecordingAuthority } from '@agent-device/contracts/screen-recording-runtime-host';

type AppleRunnerScreenRecordingStartRequest = Readonly<{
  device: DeviceInfo;
  appBundleId: string;
  outputPath: string;
  fps?: number;
  signal?: AbortSignal;
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
}>;

type AppleRunnerScreenRecordingStartResult = Readonly<{
  recordingAuthority: RunnerRecordingAuthority;
  startState: 'active' | 'uncertain';
  recorderStartUptimeMs?: number;
}>;

export type AppleRunnerScreenRecordingTransport = Readonly<{
  authority: 'local-lease' | 'scoped-provider';
  available: boolean;
  start(
    request: AppleRunnerScreenRecordingStartRequest,
  ): Promise<AppleRunnerScreenRecordingStartResult>;
  inspect(
    device: DeviceInfo,
    recordingAuthority: RunnerRecordingAuthority,
  ): Promise<ManagedProcessOwnership>;
  stop(
    request: Readonly<{
      device: DeviceInfo;
      recordingAuthority: RunnerRecordingAuthority;
      appBundleId?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<void>;
  release(
    request: Readonly<{
      device: DeviceInfo;
      recordingAuthority: RunnerRecordingAuthority;
      reason: 'retrieved' | 'abandoned';
    }>,
  ): Promise<void>;
  retrieve(
    request: Readonly<{
      device: DeviceInfo;
      recordingAuthority: RunnerRecordingAuthority;
      outputPath: string;
      signal?: AbortSignal;
    }>,
  ): Promise<void>;
}>;

const localTransport: AppleRunnerScreenRecordingTransport = Object.freeze({
  authority: 'local-lease',
  available: true,
  start: startLocalAppleRunnerRecording,
  inspect: async (device, recordingAuthority) =>
    await inspectLocalRunner(device, recordingAuthority),
  stop: async ({ device, recordingAuthority, appBundleId, signal }) => {
    const { getRunnerSessionSnapshot } = await loadAppleRunnerRecordingOperations();
    if (getRunnerSessionSnapshot(device.id)?.alive) {
      await stopActiveRunnerRecording(device, recordingAuthority, appBundleId, signal);
      return;
    }
    await stopRecoverableRunnerRecording(device, recordingAuthority, appBundleId, signal);
  },
  release: async ({ device, recordingAuthority, reason }) => {
    const { getRunnerSessionSnapshot, releaseRunnerRecordingPin } =
      await loadAppleRunnerRecordingOperations();
    if (getRunnerSessionSnapshot(device.id)?.alive) {
      await releaseRunnerRecordingPin(device.id, recordingAuthority, reason);
      return;
    }
    const { releaseRecoverableRunnerRecordingLease } = await loadAppleRunnerRecordingOperations();
    await releaseRecoverableRunnerRecordingLease(device.id, recordingAuthority);
  },
  retrieve: async ({ device, recordingAuthority, outputPath, signal }) =>
    await retrieveLocalRunnerRecording(device, recordingAuthority, outputPath, signal),
});

async function startLocalAppleRunnerRecording({
  device,
  appBundleId,
  outputPath,
  fps,
  signal,
  iosXctestrunFile,
  iosXctestDerivedDataPath,
  iosXctestEnvDir,
}: AppleRunnerScreenRecordingStartRequest): Promise<AppleRunnerScreenRecordingStartResult> {
  const {
    acquireRunnerRecordingPin,
    disposeRunnerAfterRejectedRecordingStart,
    rollbackRunnerRecordingPin,
    runAppleRunnerCommandWithReceipt,
  } = await loadAppleRunnerRecordingOperations();
  const { withRunnerCommandId } = await loadAppleRunnerRecordingOperations();
  const recordingFileName = `agent-device-recording-${Date.now()}.mp4`;
  const remotePath =
    device.appleOs === 'macos' || device.kind !== 'device' ? undefined : `tmp/${recordingFileName}`;
  const command = withRunnerCommandId({
    command: 'recordStart',
    outPath: runnerOutputPath(device, outputPath, recordingFileName, remotePath),
    ...(fps === undefined ? {} : { fps }),
    appBundleId,
  });
  const recordingAuthority = await acquireRunnerRecordingPin(
    device,
    {
      startCommandId: command.commandId!,
      ...(remotePath === undefined ? {} : { remotePath }),
    },
    {
      signal,
      iosXctestrunFile,
      iosXctestDerivedDataPath,
      iosXctestEnvDir,
    },
  );
  let execution;
  try {
    execution = await runAppleRunnerCommandWithReceipt(device, command, {
      signal,
      expectedRunnerSessionId: recordingAuthority.runnerSessionId,
      expectedRunnerLaunchIdentity: recordingAuthority.launchIdentity,
    });
  } catch (error) {
    const { runnerCommandDispatchWasAttempted, runnerCommandWasRejected } =
      await loadAppleRunnerRecordingOperations();
    const rejected = runnerCommandWasRejected(error);
    if (!runnerCommandDispatchWasAttempted(error)) {
      await rollbackRunnerRecordingPin(device.id, recordingAuthority);
      throw error;
    }
    if (rejected) {
      if (runnerRejectedUntrackedRecording(error)) {
        try {
          await disposeRunnerAfterRejectedRecordingStart(device.id, recordingAuthority);
        } catch (resetError) {
          throw preserveRecordingRejection(error, resetError);
        }
      } else {
        await rollbackRunnerRecordingPin(device.id, recordingAuthority);
      }
      throw error;
    }
    return freezeRunnerStartResult(recordingAuthority, 'uncertain');
  }
  return freezeRunnerStartResult(
    recordingAuthority,
    signal?.aborted ? 'uncertain' : 'active',
    execution.data,
  );
}

function preserveRecordingRejection(error: unknown, resetError: unknown): AppError {
  const original =
    error instanceof AppError
      ? error
      : new AppError(
          'COMMAND_FAILED',
          error instanceof Error ? error.message : String(error),
          undefined,
          error instanceof Error ? error : undefined,
        );
  return new AppError(
    original.code,
    original.message,
    {
      ...(original.details ?? {}),
      runnerResetFailure: resetError instanceof Error ? resetError.message : String(resetError),
    },
    original,
  );
}

function runnerRejectedUntrackedRecording(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof AppError &&
      current.details?.runnerErrorCode === 'RECORDING_ALREADY_ACTIVE'
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function runnerOutputPath(
  device: DeviceInfo,
  outputPath: string,
  recordingFileName: string,
  remotePath: string | undefined,
): string {
  if (device.appleOs === 'macos') return outputPath;
  return remotePath === undefined ? path.basename(outputPath) : recordingFileName;
}

function freezeRunnerStartResult(
  recordingAuthority: RunnerRecordingAuthority,
  startState: 'active' | 'uncertain',
  timing: Readonly<{ recorderStartUptimeMs?: unknown }> = {},
): AppleRunnerScreenRecordingStartResult {
  return Object.freeze({
    recordingAuthority,
    startState,
    ...(typeof timing.recorderStartUptimeMs === 'number'
      ? { recorderStartUptimeMs: timing.recorderStartUptimeMs }
      : {}),
  });
}

const unavailableScopedTransport: AppleRunnerScreenRecordingTransport = Object.freeze({
  authority: 'scoped-provider',
  available: false,
  start: async () => {
    throw new Error('Scoped Apple runner provider does not expose durable recording authority');
  },
  inspect: async () => 'ownership-lost' as const,
  stop: async () => {
    throw new Error('Scoped Apple runner recording authority is unavailable');
  },
  release: async () => {
    throw new Error('Scoped Apple runner recording authority is unavailable');
  },
  retrieve: async () => {
    throw new Error('Scoped Apple runner recording authority is unavailable');
  },
});

const transportScope = createScopedProvider(localTransport);

export function resolveAppleRunnerScreenRecordingTransport(): AppleRunnerScreenRecordingTransport {
  return transportScope.resolve();
}

export async function withAppleRunnerScreenRecordingTransport<T>(
  transport: AppleRunnerScreenRecordingTransport | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return await transportScope.run(transport ?? unavailableScopedTransport, task);
}

export async function reconcileLocalAppleRunnerRecordingOrphan(
  device: DeviceInfo,
  signal?: AbortSignal,
): Promise<'missing' | 'reconciled'> {
  const [{ reconcileOrphanRunnerRecordingLease }, transport, contract] = await Promise.all([
    loadAppleRunnerRecordingOperations(),
    loadAppleRunnerRecordingOperations(),
    loadAppleRunnerRecordingOperations(),
  ]);
  return await reconcileOrphanRunnerRecordingLease(
    device.id,
    async ({ port, recordingAuthority }) => {
      const response = await transport.sendRunnerCommandOnce(
        device,
        port,
        contract.withRunnerCommandId({
          command: 'recordStop',
          recordingStartCommandId: recordingAuthority.startCommandId,
        }),
        transport.RUNNER_COMMAND_TIMEOUT_MS,
        signal,
      );
      await requireSuccessfulRunnerResponse(
        response,
        `recordStop for ${recordingAuthority.startCommandId}`,
      );
    },
  );
}

async function inspectLocalRunner(
  device: DeviceInfo,
  recordingAuthority: RunnerRecordingAuthority,
): Promise<ManagedProcessOwnership> {
  const [
    { getRunnerSessionSnapshot, sameRunnerRecordingAuthority },
    { inspectRecoverableRunnerRecordingLease },
  ] = await Promise.all([
    loadAppleRunnerRecordingOperations(),
    loadAppleRunnerRecordingOperations(),
  ]);
  const active = getRunnerSessionSnapshot(device.id);
  if (active?.alive) {
    return active.recordingAuthority &&
      sameRunnerRecordingAuthority(active.recordingAuthority, recordingAuthority)
      ? 'owned-alive'
      : 'ownership-lost';
  }
  return await inspectRecoverableRunnerRecordingLease(device.id, recordingAuthority);
}

async function stopActiveRunnerRecording(
  device: DeviceInfo,
  recordingAuthority: RunnerRecordingAuthority,
  appBundleId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const { assertRunnerRecordingAuthority, runAppleRunnerCommand, updateRunnerRecordingPin } =
    await loadAppleRunnerRecordingOperations();
  await assertRunnerRecordingAuthority(device.id, recordingAuthority);
  await runAppleRunnerCommand(
    device,
    {
      command: 'recordStop',
      appBundleId,
      recordingStartCommandId: recordingAuthority.startCommandId,
    },
    {
      signal,
      expectedRunnerSessionId: recordingAuthority.runnerSessionId,
      expectedRunnerLaunchIdentity: recordingAuthority.launchIdentity,
    },
  );
  await updateRunnerRecordingPin(device.id, recordingAuthority, 'finalized');
}

async function stopRecoverableRunnerRecording(
  device: DeviceInfo,
  recordingAuthority: RunnerRecordingAuthority,
  appBundleId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const [{ finalizeRecoverableRunnerRecordingLease }, transport, contract] = await Promise.all([
    loadAppleRunnerRecordingOperations(),
    loadAppleRunnerRecordingOperations(),
    loadAppleRunnerRecordingOperations(),
  ]);
  await finalizeRecoverableRunnerRecordingLease(device.id, recordingAuthority, async ({ port }) => {
    const response = await transport.sendRunnerCommandOnce(
      device,
      port,
      contract.withRunnerCommandId({
        command: 'recordStop',
        appBundleId,
        recordingStartCommandId: recordingAuthority.startCommandId,
      }),
      transport.RUNNER_COMMAND_TIMEOUT_MS,
      signal,
    );
    await requireSuccessfulRunnerResponse(response, 'recordStop');
  });
}

async function retrieveLocalRunnerRecording(
  device: DeviceInfo,
  recordingAuthority: RunnerRecordingAuthority,
  outputPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted();
  const { getRunnerSessionSnapshot } = await loadAppleRunnerRecordingOperations();
  if (getRunnerSessionSnapshot(device.id)?.alive) {
    await retrieveActiveRunnerRecording(device, recordingAuthority, outputPath, signal);
  } else {
    const { retrieveRecoverableRunnerRecordingLease } = await loadAppleRunnerRecordingOperations();
    await retrieveRecoverableRunnerRecordingLease(
      device.id,
      recordingAuthority,
      async ({ remotePath, testHostContainerBundleId }) => {
        signal?.throwIfAborted();
        const { resolveIosPhysicalDeviceControl } =
          await import('@agent-device/platform-apple/physical-device');
        await resolveIosPhysicalDeviceControl(device).copyRunnerFile(
          device,
          remotePath,
          outputPath,
          testHostContainerBundleId,
          undefined,
          signal,
        );
        signal?.throwIfAborted();
      },
    );
  }
}

async function retrieveActiveRunnerRecording(
  device: DeviceInfo,
  recordingAuthority: RunnerRecordingAuthority,
  outputPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const remotePath = recordingAuthority.remotePath;
  if (!remotePath) throw new Error('Apple runner recording authority has no remote media path');
  const { assertRunnerRecordingAuthority, releaseRunnerRecordingPin } =
    await loadAppleRunnerRecordingOperations();
  await assertRunnerRecordingAuthority(device.id, recordingAuthority);
  signal?.throwIfAborted();
  const { resolveIosPhysicalDeviceControl } =
    await import('@agent-device/platform-apple/physical-device');
  await resolveIosPhysicalDeviceControl(device).copyRunnerFile(
    device,
    remotePath,
    outputPath,
    recordingAuthority.launchIdentity.testHostContainerBundleId,
    undefined,
    signal,
  );
  // Once release starts, retrieval is committed: a later cancellation must not
  // retroactively turn a copied-and-released take back into retryable authority.
  signal?.throwIfAborted();
  await releaseRunnerRecordingPin(device.id, recordingAuthority, 'retrieved');
}

async function requireSuccessfulRunnerResponse(response: Response, command: string): Promise<void> {
  const { decodeRunnerResponseBody, isRunnerResponseOk, buildRunnerResponseError } =
    await loadAppleRunnerRecordingOperations();
  let payload;
  try {
    payload = decodeRunnerResponseBody(await response.text());
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Exact ${command} recovery returned invalid JSON`,
      undefined,
      error,
    );
  }
  if (!isRunnerResponseOk(payload)) throw buildRunnerResponseError(payload);
}
