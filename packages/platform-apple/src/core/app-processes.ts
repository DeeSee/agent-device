// Copyright 2026 Yandex LLC. All rights reserved.

import type { AppProcessesRuntimeResult } from '@agent-device/contracts/app-processes-runtime';
import { resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { resolveIosDeviceAppProcesses } from './devicectl.ts';
import { resolveAppleExecutable, parseApplePsOutput } from './perf-target.ts';
import { matchesAppleExecutableProcess } from './perf-process-identity.ts';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { runXcrun } from './tool-provider.ts';

export async function observeIosAppProcesses(
  device: DeviceInfo,
  appBundleId: string,
  signal: AbortSignal,
): Promise<AppProcessesRuntimeResult> {
  signal.throwIfAborted();
  const leaf = resolveDeviceAppleOs(device);
  if (
    (leaf !== 'ios' && leaf !== 'ipados') ||
    (device.kind !== 'simulator' && device.kind !== 'device') ||
    device.iosPhysicalDeviceBackend === 'xctest'
  ) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'App process observation requires an iOS simulator or CoreDevice-backed physical device.',
    );
  }
  const processIds =
    device.kind === 'simulator'
      ? await simulatorAppProcessIds(device, appBundleId, signal)
      : (await resolveIosDeviceAppProcesses(device, appBundleId, signal)).processes.map(
          ({ pid }) => pid,
        );
  signal.throwIfAborted();
  if (processIds.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new AppError('COMMAND_FAILED', 'Process observation returned an invalid process ID.');
  }
  return Object.freeze({
    processIds: Object.freeze([...new Set(processIds)].sort((left, right) => left - right)),
  });
}

async function simulatorAppProcessIds(
  device: DeviceInfo,
  appBundleId: string,
  signal: AbortSignal,
): Promise<number[]> {
  const executable = await resolveAppleExecutable(device, appBundleId, signal);
  const result = requireExecSuccess(
    await runXcrun(
      buildSimctlArgsForDevice(device, [
        'spawn',
        device.id,
        'ps',
        '-axo',
        'pid=,%cpu=,rss=,command=',
      ]),
      { allowFailure: true, timeoutMs: 15_000, signal },
    ),
    'Failed to list iOS simulator app processes',
    { appBundleId },
  );
  return parseApplePsOutput(result.stdout)
    .filter((process) => matchesAppleExecutableProcess(process.command, executable))
    .map(({ pid }) => pid);
}
