import fs from 'node:fs';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import { runCmdDetachedMonitored, type ExecDetachedExit } from '@agent-device/host-kit/command';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { sleep } from '@agent-device/host-kit/retry';
import { stopProcessForTakeover } from '../daemon-process.ts';
import { resolveDaemonLaunchSpec } from './daemon-launch-spec.ts';
import {
  type DaemonClientSettings,
  type EnsuredDaemon,
  requireLocalDeviceClaimRoot,
  refuseClaimRootMismatch,
} from './daemon-client-settings.ts';
import {
  cleanupFailedDaemonStartupMetadata,
  getDaemonMetadataState,
  isDaemonLockHeldByAnotherDaemon,
  readDaemonInfo,
  recoverDaemonLockHolder,
  resolveDaemonStartupHint,
  type DaemonInfo,
  type DaemonStartupCleanupResult,
} from './daemon-client-metadata.ts';
import { canConnect } from './daemon-client-transport.ts';
type ReuseLocalDaemon = (settings: DaemonClientSettings) => Promise<DaemonInfo | null>;

type DaemonStartupLaunch = {
  pid: number;
  /** The launched process's start time, so a reused pid is never taken for it. */
  startTime?: string;
  exited: Promise<ExecDetachedExit>;
  release(): void;
};

export type DaemonStartupWaitResult =
  | { kind: 'ready'; daemon: EnsuredDaemon }
  | { kind: 'early_exit'; exit: ExecDetachedExit }
  | { kind: 'timeout' };

const DAEMON_STARTUP_TIMEOUT_MS = 15_000;

const DAEMON_STARTUP_ATTEMPTS = 2;

const DAEMON_STARTUP_LOG_TAIL_BYTES = 64_000;

type DaemonStartupContext = Readonly<{
  settings: DaemonClientSettings;
  readReusableLocalDaemon: ReuseLocalDaemon;
  signal?: AbortSignal;
  deadlineMs: number;
}>;

type DaemonStartupDiagnostics = {
  lockRecoveryCount: number;
  cleanupResults: DaemonStartupCleanupResult[];
  startError?: string;
  daemonProcess?: ExecDetachedExit | { pid: number };
};

type DaemonStartupAttempt = { kind: 'ready'; daemon: EnsuredDaemon } | { kind: 'retry' | 'stop' };

export async function startLocalDaemon(
  settings: DaemonClientSettings,
  readReusableLocalDaemon: ReuseLocalDaemon,
  signal?: AbortSignal,
): Promise<EnsuredDaemon> {
  const context = {
    settings,
    readReusableLocalDaemon,
    signal,
    deadlineMs: Date.now() + DAEMON_STARTUP_TIMEOUT_MS,
  };
  const diagnostics: DaemonStartupDiagnostics = { lockRecoveryCount: 0, cleanupResults: [] };
  for (let attempt = 1; attempt <= DAEMON_STARTUP_ATTEMPTS; attempt += 1) {
    throwIfStartupCancelled(signal);
    if (Date.now() >= context.deadlineMs) break;
    const outcome = await runDaemonStartupAttempt(context, diagnostics, attempt);
    if (outcome.kind === 'ready') return outcome.daemon;
    if (outcome.kind === 'stop') break;
  }
  throw daemonStartupFailed(settings, diagnostics);
}

async function runDaemonStartupAttempt(
  context: DaemonStartupContext,
  diagnostics: DaemonStartupDiagnostics,
  attempt: number,
): Promise<DaemonStartupAttempt> {
  const { settings, signal, deadlineMs, readReusableLocalDaemon } = context;
  let launch: DaemonStartupLaunch;
  try {
    launch = await startDaemon(settings);
    diagnostics.daemonProcess = { pid: launch.pid };
  } catch (error) {
    if (isRequestCanceledError(error)) throw error;
    diagnostics.startError = startupErrorMessage(error);
    return await retryFailedDaemonLaunch(context, diagnostics, attempt);
  }
  const startup = await waitForDaemonStartupWithContainment(
    () => waitForDaemonStartup(deadlineMs, settings, launch, readReusableLocalDaemon, signal),
    () => stopOwnedStartupLaunch(launch),
    () => launch.release(),
  );
  if (startup.kind === 'ready') {
    launch.release();
    return startup;
  }
  if (startup.kind === 'early_exit') {
    recordDaemonEarlyExit(launch, startup.exit, diagnostics);
    return await retryFailedDaemonLaunch(context, diagnostics, attempt);
  }
  return await settleTimedOutDaemonLaunch(context, diagnostics, launch, attempt);
}

function startupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordDaemonEarlyExit(
  launch: DaemonStartupLaunch,
  exit: ExecDetachedExit,
  diagnostics: DaemonStartupDiagnostics,
): void {
  launch.release();
  diagnostics.daemonProcess = exit;
  diagnostics.startError = describeDaemonEarlyExit(exit);
}

async function retryFailedDaemonLaunch(
  context: DaemonStartupContext,
  diagnostics: DaemonStartupDiagnostics,
  attempt: number,
): Promise<DaemonStartupAttempt> {
  const cleanup = await cleanupFailedDaemonStartupMetadata(context.settings.paths, 'start_error');
  diagnostics.cleanupResults.push(cleanup);
  if (cleanupRetainedDaemonOwner(cleanup) || attempt >= DAEMON_STARTUP_ATTEMPTS)
    return { kind: 'stop' };
  await sleep(150);
  return { kind: 'retry' };
}

async function settleTimedOutDaemonLaunch(
  context: DaemonStartupContext,
  diagnostics: DaemonStartupDiagnostics,
  launch: DaemonStartupLaunch,
  attempt: number,
): Promise<DaemonStartupAttempt> {
  const { settings } = context;
  try {
    await stopOwnedStartupLaunch(launch);
    launch.release();
  } catch (error) {
    diagnostics.startError = startupErrorMessage(error);
    diagnostics.cleanupResults.push(
      await cleanupFailedDaemonStartupMetadata(settings.paths, 'startup_timeout'),
    );
    return { kind: 'stop' };
  }
  if (await recoverDaemonLockHolder(settings.paths)) {
    diagnostics.lockRecoveryCount += 1;
    return { kind: 'retry' };
  }
  const metadataState = getDaemonMetadataState(settings.paths);
  const cleanup = await cleanupFailedDaemonStartupMetadata(settings.paths, 'startup_timeout');
  diagnostics.cleanupResults.push(cleanup);
  if (cleanupRetainedDaemonOwner(cleanup))
    return await observeRetainedStartupOwner(context, diagnostics, launch);
  if (attempt >= DAEMON_STARTUP_ATTEMPTS) return { kind: 'stop' };
  // Detached startup may have raced without publishing metadata yet.
  if (!metadataState.hasInfo && !metadataState.hasLock) await sleep(150);
  return { kind: 'retry' };
}

async function observeRetainedStartupOwner(
  context: DaemonStartupContext,
  diagnostics: DaemonStartupDiagnostics,
  launch: DaemonStartupLaunch,
): Promise<DaemonStartupAttempt> {
  const startup = await waitForDaemonStartup(
    context.deadlineMs,
    context.settings,
    launch,
    context.readReusableLocalDaemon,
    context.signal,
  );
  if (startup.kind === 'ready') {
    launch.release();
    return startup;
  }
  if (startup.kind === 'early_exit') recordDaemonEarlyExit(launch, startup.exit, diagnostics);
  return { kind: 'stop' };
}

function daemonStartupFailed(
  settings: DaemonClientSettings,
  diagnostics: DaemonStartupDiagnostics,
): AppError {
  const state = getDaemonMetadataState(settings.paths);
  const daemonLogTail = readRecentLogTail(settings.paths.logPath);
  return new AppError('COMMAND_FAILED', 'Failed to start daemon', {
    kind: 'daemon_startup_failed',
    stateDir: settings.paths.baseDir,
    infoPath: settings.paths.infoPath,
    lockPath: settings.paths.lockPath,
    logPath: settings.paths.logPath,
    startupTimeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
    startupAttempts: DAEMON_STARTUP_ATTEMPTS,
    ...diagnostics,
    ...(daemonLogTail ? { daemonLogTail } : {}),
    metadataState: state,
    hint: resolveDaemonStartupHint(state, settings.paths),
  });
}

function cleanupRetainedDaemonOwner(cleanup: DaemonStartupCleanupResult): boolean {
  return cleanup.retainedInfoProcess === true || cleanup.retainedLockProcess === true;
}

export async function waitForDaemonStartupWithContainment(
  observe: () => Promise<DaemonStartupWaitResult>,
  stopExactLaunch: () => Promise<void>,
  releaseLaunch: () => void,
): Promise<DaemonStartupWaitResult> {
  try {
    return await observe();
  } catch (error) {
    await stopExactLaunch();
    releaseLaunch();
    throw error;
  }
}

async function waitForDaemonStartup(
  deadlineMs: number,
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
  readReusableLocalDaemon: ReuseLocalDaemon,
  signal?: AbortSignal,
): Promise<DaemonStartupWaitResult> {
  let earlyExit: ExecDetachedExit | undefined;
  void launch.exited.then((exit) => {
    earlyExit = exit;
  });

  while (Date.now() < deadlineMs) {
    throwIfStartupCancelled(signal);
    const info = readDaemonInfo(settings.paths.infoPath);
    if (info && (await canConnect(info, settings.transportPreference))) {
      refuseClaimRootMismatch(info, true, settings);
      if (isLaunchedDaemon(info, launch)) {
        return { kind: 'ready', daemon: { info, startedByClient: true } };
      }
      // Another client's daemon won the start: adopt it only as a reusable daemon would be. An
      // incompatible one is replaced, and this wait then sees its own daemon's early exit.
      const winner = await readReusableLocalDaemon(settings);
      if (winner) return { kind: 'ready', daemon: { info: winner, startedByClient: false } };
    }
    // A daemon that lost the startup lock exits cleanly; the daemon that won it is still starting.
    if (earlyExit && !isDaemonLockHeldByAnotherDaemon(settings.paths, earlyExit.pid)) {
      return { kind: 'early_exit', exit: earlyExit };
    }
    await sleep(Math.min(100, Math.max(1, deadlineMs - Date.now())));
  }
  throwIfStartupCancelled(signal);
  if (earlyExit) return { kind: 'early_exit', exit: earlyExit };
  return { kind: 'timeout' };
}

/** Whether `info` names the daemon process this client launched: same pid and start time. */
function isLaunchedDaemon(info: DaemonInfo, launch: DaemonStartupLaunch): boolean {
  return (
    info.pid === launch.pid &&
    launch.startTime !== undefined &&
    info.processStartTime === launch.startTime
  );
}

async function startDaemon(settings: DaemonClientSettings): Promise<DaemonStartupLaunch> {
  const launchSpec = resolveDaemonLaunchSpec();
  const args = launchSpec.useSrc
    ? ['--experimental-strip-types', launchSpec.srcPath]
    : [launchSpec.distPath];
  args.push('--device-claims-dir', requireLocalDeviceClaimRoot(settings).path);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DEVICE_STATE_DIR: settings.paths.baseDir,
    AGENT_DEVICE_DAEMON_SERVER_MODE: settings.serverMode,
  };
  delete env.AGENT_DEVICE_CLAIMS_DIR;

  fs.mkdirSync(settings.paths.baseDir, { recursive: true });
  const stdoutFd = fs.openSync(settings.paths.logPath, 'a');
  const stderrFd = fs.openSync(settings.paths.logPath, 'a');
  try {
    const launch = runCmdDetachedMonitored(process.execPath, args, {
      env,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    return {
      ...launch,
      startTime: readProcessStartTime(launch.pid) ?? undefined,
      release: () => {},
    };
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

async function stopOwnedStartupLaunch(launch: DaemonStartupLaunch): Promise<void> {
  await stopProcessForTakeover(launch.pid, {
    termTimeoutMs: 3_000,
    killTimeoutMs: 1_000,
    expectedStartTime: launch.startTime,
  });
}

export function throwIfStartupCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createRequestCanceledError({ phase: 'daemon_startup' });
  }
}

function describeDaemonEarlyExit(exit: ExecDetachedExit): string {
  if (exit.error) return `daemon process ${exit.pid} failed to start: ${exit.error}`;
  if (exit.signal)
    return `daemon process ${exit.pid} exited before readiness with signal ${exit.signal}`;
  return `daemon process ${exit.pid} exited before readiness with code ${exit.exitCode ?? 0}`;
}

function readRecentLogTail(logPath: string): string | undefined {
  try {
    if (!fs.existsSync(logPath)) return undefined;
    const stats = fs.statSync(logPath);
    if (stats.size <= 0) return undefined;
    const length = Math.min(stats.size, DAEMON_STARTUP_LOG_TAIL_BYTES);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stats.size - length);
      const text = buffer.toString('utf8').trim();
      return text.length > 0 ? text : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
