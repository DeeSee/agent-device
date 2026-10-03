import {
  isProcessAlive,
  readHostProcessIdentityObservations,
  readProcessCommand,
  readProcessStartTime,
} from '@agent-device/host-kit/process';
import { AppError } from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';

const DAEMON_COMMAND_PATTERNS = [
  /\/dist\/src\/daemon\.js($|[\s"'])/,
  /\/dist\/src\/internal\/daemon\.js($|[\s"'])/,
  /\/src\/daemon\.ts($|[\s"'])/,
];

/**
 * Identity is the daemon entry path, never the checkout's directory name: a
 * git worktree is named after its branch, so a `agent-device` substring gate
 * classified every worktree daemon as "not ours" (#1545). The pid always
 * comes from our own daemon.json/daemon.lock alongside the processStartTime
 * recorded with it. Missing identity must fail closed so a stale PID cannot
 * be authorized by the path match alone.
 */
export function isAgentDeviceDaemonCommand(command: string): boolean {
  const normalized = command.toLowerCase().replaceAll('\\', '/');
  return DAEMON_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isAgentDeviceDaemonProcess(pid: number, expectedStartTime?: string): boolean {
  return inspectAgentDeviceDaemonProcess(pid, expectedStartTime) === 'match';
}

export type AgentDeviceDaemonProcessObservation = 'match' | 'absent' | 'different' | 'unknown';

export function inspectAgentDeviceDaemonProcess(
  pid: number,
  expectedStartTime?: string,
): AgentDeviceDaemonProcessObservation {
  if (!isProcessAlive(pid)) return 'absent';
  const normalizedExpectedStartTime = expectedStartTime?.trim();
  if (!normalizedExpectedStartTime) return 'unknown';
  const actualStartTime = readProcessStartTime(pid)?.trim();
  if (!actualStartTime) return 'unknown';
  if (actualStartTime !== normalizedExpectedStartTime) return 'different';
  const command = readProcessCommand(pid);
  if (!command) return 'unknown';
  return isAgentDeviceDaemonCommand(command) ? 'match' : 'different';
}

export function trySignalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw error;
  }
}

/** A daemon pinned to one process lifetime, never a bare pid. */
export type DaemonProcessIdentity = {
  pid: number;
  startTime: string;
};

export type DaemonExitWait = {
  /** The pid was released, or the host handed it to a different process. */
  exited: boolean;
  elapsedMs: number;
};

const DAEMON_EXIT_POLL_MS = 100;

type DaemonPidState = 'ours' | 'exiting' | 'released' | 'recycled';

function classifyDaemonPid(identity: DaemonProcessIdentity): DaemonPidState {
  if (!isProcessAlive(identity.pid)) return 'released';
  // A terminated pid awaiting reap answers kill(pid, 0), keeps its start time, and
  // reports its command as `<defunct>`; only the process state distinguishes it.
  const observed = readHostProcessIdentityObservations([identity.pid]).get(identity.pid);
  if (!observed || observed.state.startsWith('Z')) return 'exiting';
  if (observed.startTime !== identity.startTime) return 'recycled';
  const command = readProcessCommand(identity.pid);
  if (!command) return 'exiting';
  return isAgentDeviceDaemonCommand(command) ? 'ours' : 'recycled';
}

/**
 * Resolves once `identity` has left the host — released or recycled. A pid still
 * being torn down is neither, so the wait continues until the number is free.
 */
export async function waitForDaemonExit(
  identity: DaemonProcessIdentity,
  options: { timeoutMs: number; pollMs?: number },
): Promise<DaemonExitWait> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const pollMs = options.pollMs ?? DAEMON_EXIT_POLL_MS;
  const hasExited = (): boolean => {
    const state = classifyDaemonPid(identity);
    return state === 'released' || state === 'recycled';
  };
  let exited = hasExited();
  while (!exited && Date.now() < deadline) {
    await sleep(pollMs);
    exited = hasExited();
  }
  return { exited, elapsedMs: Date.now() - startedAt };
}

export type DaemonTakeoverEffects = Readonly<{
  inspectDaemonProcess(
    pid: number,
    expectedStartTime?: string,
  ): AgentDeviceDaemonProcessObservation;
  trySignal(pid: number, signal: NodeJS.Signals): boolean;
  waitForExit(pid: number, timeoutMs: number, expectedStartTime: string): Promise<boolean>;
}>;

const daemonTakeoverEffects: DaemonTakeoverEffects = {
  inspectDaemonProcess: inspectAgentDeviceDaemonProcess,
  trySignal: trySignalProcess,
  waitForExit: async (pid, timeoutMs, startTime) =>
    (await waitForDaemonExit({ pid, startTime }, { timeoutMs })).exited,
};

export async function stopProcessForTakeover(
  pid: number,
  options: {
    termTimeoutMs: number;
    killTimeoutMs: number;
    expectedStartTime: string | undefined;
  },
  effects: DaemonTakeoverEffects = daemonTakeoverEffects,
): Promise<void> {
  const initialOwner = effects.inspectDaemonProcess(pid, options.expectedStartTime);
  requireInspectableTakeoverOwner(pid, options.expectedStartTime, initialOwner);
  if (initialOwner !== 'match') return;
  if (!effects.trySignal(pid, 'SIGTERM')) {
    refuseIfExactDaemonStillLives(pid, options.expectedStartTime, 'term_signal', effects);
    return;
  }
  if (await effects.waitForExit(pid, options.termTimeoutMs, options.expectedStartTime!)) return;
  if (!exactDaemonStillLives(pid, options.expectedStartTime, effects)) return;
  if (!effects.trySignal(pid, 'SIGKILL')) {
    refuseIfExactDaemonStillLives(pid, options.expectedStartTime, 'kill_signal', effects);
    return;
  }
  if (await effects.waitForExit(pid, options.killTimeoutMs, options.expectedStartTime!)) return;
  refuseIfExactDaemonStillLives(pid, options.expectedStartTime, 'kill_timeout', effects);
}

function refuseIfExactDaemonStillLives(
  pid: number,
  expectedStartTime: string | undefined,
  phase: 'term_signal' | 'kill_signal' | 'kill_timeout',
  effects: DaemonTakeoverEffects,
): void {
  const observation = effects.inspectDaemonProcess(pid, expectedStartTime);
  if (observation === 'absent' || observation === 'different') return;
  throw daemonTakeoverIncomplete(pid, expectedStartTime, phase);
}

function exactDaemonStillLives(
  pid: number,
  expectedStartTime: string | undefined,
  effects: DaemonTakeoverEffects,
): boolean {
  const observation = effects.inspectDaemonProcess(pid, expectedStartTime);
  if (observation === 'unknown') {
    throw daemonTakeoverIncomplete(pid, expectedStartTime, 'identity_verification');
  }
  return observation === 'match';
}

function requireInspectableTakeoverOwner(
  pid: number,
  expectedStartTime: string | undefined,
  observation: AgentDeviceDaemonProcessObservation,
): void {
  if (observation === 'unknown') {
    throw daemonTakeoverIncomplete(pid, expectedStartTime, 'identity_verification');
  }
}

function daemonTakeoverIncomplete(
  pid: number,
  expectedStartTime: string | undefined,
  phase: 'identity_verification' | 'term_signal' | 'kill_signal' | 'kill_timeout',
): AppError {
  return new AppError('COMMAND_FAILED', 'Refusing to replace a still-running agent-device daemon', {
    reason: 'daemon_takeover_incomplete',
    phase,
    pid,
    ...(expectedStartTime ? { expectedStartTime } : {}),
    hint: 'The existing daemon could not be confirmed stopped. Keep its metadata, stop it with sufficient host permissions, then retry.',
  });
}
