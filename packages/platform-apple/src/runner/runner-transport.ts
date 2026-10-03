import { createRequestCanceledError, AppError, asAppError } from '@agent-device/kernel/errors';
import { Deadline, resolveIosPhysicalDeviceControl } from './host.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createRunnerCommandRouteResolver } from './runner-command-route.ts';
import { isUsbmuxDeviceUnattachedError } from './runner-error-classification.ts';
import type { RunnerCommand } from './runner-contract.ts';
import { usbmuxRunnerTransport } from './runner-usbmux.ts';

export const RUNNER_COMMAND_TIMEOUT_MS = 45_000;

export async function sendRunnerCommandOnce(
  device: DeviceInfo,
  port: number,
  command: RunnerCommand,
  timeoutMs: number = RUNNER_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) {
    throw createRequestCanceledError();
  }
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const resolver = createRunnerCommandRouteResolver(device, port);
  let route = await resolver.resolveRoute(deadline.remainingMs());
  if (route.kind === 'usbmux') {
    try {
      return await postUsbmuxRunnerCommand(device, port, command, deadline, signal);
    } catch (error) {
      if (!canFallBackFromUsbmux(device, error)) throw error;
      resolver.markUsbmuxUnattached();
      route = await resolver.resolveRoute(deadline.remainingMs());
    }
  }
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) {
    throw new AppError('COMMAND_FAILED', 'Runner command deadline exceeded', { timeoutMs });
  }
  const endpoint = route.endpoints[0];
  if (!endpoint) {
    throw new AppError('COMMAND_FAILED', 'Runner command endpoint not available', {
      port,
      endpoints: route.endpoints,
    });
  }
  try {
    return await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      },
      remainingMs,
      signal,
    );
  } catch (error) {
    throw markRunnerCommandDispatchAttempted(error);
  }
}

async function postUsbmuxRunnerCommand(
  device: DeviceInfo,
  port: number,
  command: RunnerCommand,
  deadline: Deadline,
  signal?: AbortSignal,
): Promise<Response> {
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) {
    throw new AppError('COMMAND_FAILED', 'Runner command deadline exceeded', {
      port,
      timeoutMs: remainingMs,
    });
  }
  try {
    return await usbmuxRunnerTransport.postCommand(device.id, port, command, remainingMs, signal);
  } catch (error) {
    throw markRunnerCommandDispatchAttempted(error);
  }
}

export function markRunnerCommandDispatchAttempted(error: unknown): AppError {
  const appError = asAppError(error, 'COMMAND_FAILED');
  return new AppError(
    appError.code,
    appError.message,
    { ...(appError.details ?? {}), runnerCommandDispatch: 'attempted' },
    appError,
  );
}

export function runnerCommandDispatchWasAttempted(error: unknown): boolean {
  return runnerCommandHasDetail(error, 'runnerCommandDispatch', 'attempted');
}

export function runnerCommandWasRejected(error: unknown): boolean {
  return runnerCommandHasDetail(error, 'runnerCommandOutcome', 'rejected');
}

function runnerCommandHasDetail(error: unknown, key: string, value: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof AppError && current.details?.[key] === value) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * A CoreDevice-backed device that usbmuxd does not list is reachable over its
 * network tunnel instead. XCTest-backed devices have no such tunnel, so their
 * usbmux verdict stands.
 */
export function canFallBackFromUsbmux(device: DeviceInfo, error: unknown): boolean {
  if (!isUsbmuxDeviceUnattachedError(error)) return false;
  return resolveIosPhysicalDeviceControl(device).backend !== 'xctest';
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    // `AbortSignal.timeout` rejects with a bare DOMException that no recovery rule can
    // read. Only a rejection carrying that signal's own reason is our deadline: a
    // refused connection or a canceled request keeps the error it actually failed with.
    if (error === timeoutSignal.reason) {
      throw new AppError(
        'COMMAND_FAILED',
        'Runner command deadline exceeded',
        { timeoutMs },
        error,
      );
    }
    throw error;
  }
}
