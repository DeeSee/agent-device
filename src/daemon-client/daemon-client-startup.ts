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

export async function startLocalDaemon(
  settings: DaemonClientSettings,
  readReusableLocalDaemon: ReuseLocalDaemon,
  signal?: AbortSignal,
): Promise<EnsuredDaemon> {
  const startupDeadlineMs = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
  let lockRecoveryCount = 0;
  const cleanupResults: DaemonStartupCleanupResult[] = [];
  let startError: string | undefined;
  let daemonProcess: ExecDetachedExit | { pid: number } | undefined;
  for (let attempt = 1; attempt <= DAEMON_STARTUP_ATTEMPTS; attempt += 1) {
    throwIfStartupCancelled(signal);
    if (Date.now() >= startupDeadlineMs) break;
    let launch: DaemonStartupLaunch;
    try {
      launch = await startDaemon(settings);
      daemonProcess = { pid: launch.pid };
    } catch (error) {
      if (isRequestCanceledError(error)) throw error;
      startError = error instanceof Error ? error.message : String(error);
      const cleanup = await cleanupFailedDaemonStartupMetadata(settings.paths, 'start_error');
      cleanupResults.push(cleanup);
      if (cleanupRetainedDaemonOwner(cleanup)) break;
      if (attempt < DAEMON_STARTUP_ATTEMPTS) {
        await sleep(150);
        continue;
      }
      break;
    }

    const startup = await waitForDaemonStartupWithContainment(
      () =>
        waitForDaemonStartup(startupDeadlineMs, settings, launch, readReusableLocalDaemon, signal),
      () => stopOwnedStartupLaunch(launch),
      () => launch.release(),
    );
    if (startup.kind === 'ready') {
      launch.release();
      return startup.daemon;
    }
    if (startup.kind === 'early_exit') {
      launch.release();
      daemonProcess = startup.exit;
      startError = describeDaemonEarlyExit(startup.exit);
      const cleanup = await cleanupFailedDaemonStartupMetadata(settings.paths, 'start_error');
      cleanupResults.push(cleanup);
      if (cleanupRetainedDaemonOwner(cleanup)) break;
      if (attempt < DAEMON_STARTUP_ATTEMPTS) {
        await sleep(150);
        continue;
      }
      break;
    }

    try {
      await stopOwnedStartupLaunch(launch);
      launch.release();
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error);
      const cleanup = await cleanupFailedDaemonStartupMetadata(settings.paths, 'startup_timeout');
      cleanupResults.push(cleanup);
      break;
    }

    if (await recoverDaemonLockHolder(settings.paths)) {
      lockRecoveryCount += 1;
      continue;
    }

    const metadataState = getDaemonMetadataState(settings.paths);
    const hasAnotherAttempt = attempt < DAEMON_STARTUP_ATTEMPTS;
    const cleanup = await cleanupFailedDaemonStartupMetadata(settings.paths, 'startup_timeout');
    cleanupResults.push(cleanup);
    if (cleanup.retainedInfoProcess || cleanup.retainedLockProcess) {
      const extended = await waitForDaemonStartup(
        startupDeadlineMs,
        settings,
        launch,
        readReusableLocalDaemon,
        signal,
      );
      if (extended.kind === 'ready') {
        launch.release();
        return extended.daemon;
      }
      if (extended.kind === 'early_exit') {
        launch.release();
        daemonProcess = extended.exit;
        startError = describeDaemonEarlyExit(extended.exit);
      }
      break;
    }
    if (!hasAnotherAttempt) break;

    // Detached daemon startup can race on busy CI hosts; retry when no metadata exists yet.
    if (!metadataState.hasInfo && !metadataState.hasLock) await sleep(150);
  }

  const state = getDaemonMetadataState(settings.paths);
  const daemonLogTail = readRecentLogTail(settings.paths.logPath);
  throw new AppError('COMMAND_FAILED', 'Failed to start daemon', {
    kind: 'daemon_startup_failed',
    stateDir: settings.paths.baseDir,
    infoPath: settings.paths.infoPath,
    lockPath: settings.paths.lockPath,
    logPath: settings.paths.logPath,
    startupTimeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
    startupAttempts: DAEMON_STARTUP_ATTEMPTS,
    lockRecoveryCount,
    cleanupResults,
    startError,
    daemonProcess,
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
