// Copyright 2026 Yandex LLC. All rights reserved.

import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import { type ExecStreamOptions, requireExecSuccess } from '@agent-device/host-kit/command';
import {
  makeHostTemporaryDirectory,
  readHostBinaryFile,
  renameHostPath,
  removeHostDirectory,
} from '@agent-device/host-kit/host-file';
import { Deadline, sleep } from '@agent-device/host-kit/retry';
import { decodePng } from '@agent-device/capture-kit/png';
import { appleSimulatorDisplayArgvFragment, type AppleDeviceDisplay } from './display-inventory.ts';
import { runSimctlForDevice } from './simctl.ts';

type OwnedCommand = Parameters<NonNullable<ExecStreamOptions['onSpawn']>>[0];
type CommandExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
const PNG_POLL_MS = 50;
const COMPLETED_PNG_EXIT_GRACE_MS = 100;

export async function captureSimulatorScreenshotAttempt(
  device: DeviceInfo,
  outPath: string,
  display: AppleDeviceDisplay | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfSimulatorScreenshotCanceled(signal);
  const stagingDir = await makeHostTemporaryDirectory(
    '.agent-device-capture-',
    path.dirname(outPath),
  );
  const stagingPath = path.join(stagingDir, 'capture.png');
  try {
    const completion = new AbortController();
    const deadline = Deadline.fromTimeoutMs(timeoutMs);
    let child: OwnedCommand | undefined;
    let exit: CommandExit | undefined;
    let settled = false;
    const options: ExecStreamOptions = {
      timeoutMs,
      signal: signal ? AbortSignal.any([signal, completion.signal]) : completion.signal,
      kill: { signal: 'SIGINT', graceMs: 1_000 },
      onSpawn: (ownedChild) => {
        child = ownedChild;
        ownedChild.once('exit', (code, exitSignal) => {
          exit = { code, signal: exitSignal };
        });
      },
    };
    const execution = runSimctlForDevice(
      device,
      ['io', device.id, 'screenshot', ...appleSimulatorDisplayArgvFragment(display), stagingPath],
      options,
    )
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    await stopCompletedCapture(
      stagingPath,
      () => settled,
      () => child,
      completion,
      deadline,
      signal,
    );
    const outcome = await execution;
    throwIfSimulatorScreenshotCanceled(signal);
    if ('error' in outcome) {
      if (!completion.signal.aborted || !isRequestCanceledError(outcome.error)) throw outcome.error;
      if (!successfulCompletionExit(exit)) {
        throw new AppError(
          'COMMAND_FAILED',
          'Simulator screenshot command failed during capture completion',
          {
            exitCode: exit?.code,
            signal: exit?.signal,
            reason: 'simulator-screenshot-completion-failed',
          },
          outcome.error,
        );
      }
    } else {
      requireExecSuccess(outcome.result, 'Failed to capture iOS simulator screenshot');
    }
    decodePng(await readHostBinaryFile(stagingPath), 'iOS simulator screenshot');
    throwIfSimulatorScreenshotCanceled(signal);
    await renameHostPath(stagingPath, outPath);
  } finally {
    await removeHostDirectory(stagingDir);
  }
}

async function stopCompletedCapture(
  stagingPath: string,
  settled: () => boolean,
  child: () => OwnedCommand | undefined,
  completion: AbortController,
  deadline: Deadline,
  signal: AbortSignal | undefined,
): Promise<void> {
  while (!settled() && !signal?.aborted) {
    if (await hasCompletePng(stagingPath)) {
      await sleep(COMPLETED_PNG_EXIT_GRACE_MS);
      if (!settled() && canRequestCompletionStop(deadline, signal) && commandIsRunning(child())) {
        completion.abort();
      }
      return;
    }
    await sleep(PNG_POLL_MS);
  }
}

function canRequestCompletionStop(deadline: Deadline, signal: AbortSignal | undefined): boolean {
  return !signal?.aborted && !deadline.isExpired();
}

function commandIsRunning(child: OwnedCommand | undefined): boolean {
  return child?.exitCode === null && child.signalCode === null;
}

async function hasCompletePng(filePath: string): Promise<boolean> {
  try {
    decodePng(await readHostBinaryFile(filePath), 'iOS simulator screenshot');
    return true;
  } catch {
    return false;
  }
}

function successfulCompletionExit(exit: CommandExit | undefined): boolean {
  return (
    !!exit &&
    ((exit.signal === 'SIGINT' && exit.code === null) || (exit.code === 0 && exit.signal === null))
  );
}

export function throwIfSimulatorScreenshotCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createRequestCanceledError();
}
