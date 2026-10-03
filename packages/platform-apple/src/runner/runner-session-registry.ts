import { withKeyedLock } from './host.ts';
import type { RunnerSession } from './runner-session-types.ts';
export const runnerSessions = new Map<string, RunnerSession>();
const runnerSessionLocks = new Map<string, Promise<unknown>>();
export const runnerIdleStopTimers = new Map<string, NodeJS.Timeout>();

export function withRunnerSessionLock<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  return withKeyedLock(runnerSessionLocks, deviceId, task);
}

// Container paths are valid only for the runner generation that produced the file.
export const runnerSimulatorContainerCache = new Map<string, string>();
export function discardSimulatorRunnerContainerCache(
  deviceId: string,
  runnerSessionId: string,
): void {
  runnerSimulatorContainerCache.delete(`${deviceId}:${runnerSessionId}`);
}
