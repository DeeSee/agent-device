import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { Deadline } from '@agent-device/host-kit/retry';
import { IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS } from './config.ts';
import { runXcrun } from './tool-provider.ts';

export async function copyCoreDeviceRunnerFile(
  device: DeviceInfo,
  remotePath: string,
  outPath: string,
  testHostContainerBundleId: string,
  timeoutMs = IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const copyResult = await runXcrun(
    [
      'devicectl',
      'device',
      'copy',
      'from',
      '--device',
      device.id,
      '--source',
      remotePath,
      '--destination',
      outPath,
      '--domain-type',
      'appDataContainer',
      '--domain-identifier',
      testHostContainerBundleId,
    ],
    {
      allowFailure: true,
      signal,
      timeoutMs: resolveCopyTimeoutMs(deadline, timeoutMs),
    },
  );
  signal?.throwIfAborted();
  if (copyResult.exitCode === 0) return;

  const copyError =
    copyResult.stderr.trim() ||
    copyResult.stdout.trim() ||
    `devicectl exited with code ${copyResult.exitCode}`;
  throw new AppError('COMMAND_FAILED', `Failed to copy runner file from iOS device: ${copyError}`, {
    testHostContainerBundleId,
  });
}

function resolveCopyTimeoutMs(deadline: Deadline, timeoutMs: number): number {
  const remainingMs = deadline.remainingMs();
  if (remainingMs > 0) return remainingMs;
  throw new AppError('COMMAND_FAILED', `iOS runner file copy timed out after ${timeoutMs}ms`, {
    timeoutMs,
    step: 'runner file copy',
  });
}
