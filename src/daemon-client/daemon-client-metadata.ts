import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import {
  resolveDaemonLockMutationGuardPath,
  tryAcquireDaemonLockMutationGuard,
} from '../daemon-lock-mutation.ts';
import { shellQuote } from '@agent-device/kernel/device-shell';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  isAgentDeviceDaemonProcess,
  inspectAgentDeviceDaemonProcess,
  type AgentDeviceDaemonProcessObservation,
  stopProcessForTakeover,
} from '../daemon-process.ts';

import type { DaemonCodeOrigin } from '@agent-device/host-kit/code-signature';

import {
  resolveDaemonPaths,
  type DaemonPaths,
  type DaemonServerMode,
} from '../daemon-resolution.ts';

export type DaemonInfo = {
  port?: number;
  httpPort?: number;
  transport?: DaemonServerMode;
  token: string;
  pid: number;
  version?: string;
  codeOrigin?: DaemonCodeOrigin;
  codeSignature?: string;
  processStartTime?: string;
  /** ADR 0029: digest of the daemon policy the daemon enforces; absent when it has none. */
  policyDigest?: string;
  deviceClaimRootId?: string;
  baseUrl?: string;
  remoteInstanceId?: string;
  remoteUpstreamInstanceId?: string;
};

type DaemonLockInfo = {
  pid: number;
  processStartTime?: string;
  startedAt?: number;
};

export type DaemonMetadataState = {
  hasInfo: boolean;
  hasLock: boolean;
};

type DaemonStartupCleanupReason = 'start_error' | 'startup_timeout';

export type DaemonStartupCleanupResult = {
  reason: DaemonStartupCleanupReason;
  removedInfo: boolean;
  removedLock: boolean;
  stoppedInfoProcess: boolean;
  stoppedLockProcess: boolean;
  retainedInfoProcess?: boolean;
  retainedLockProcess?: boolean;
  error?: string;
};

const DAEMON_TAKEOVER_TERM_TIMEOUT_MS = 3000;
const DAEMON_TAKEOVER_KILL_TIMEOUT_MS = 1000;

export function readDaemonInfo(infoPath: string): DaemonInfo | null {
  const data = readJsonFile(infoPath);
  if (!data || typeof data !== 'object') return null;
  const parsed = data as Partial<DaemonInfo>;
  const token = readRequiredDaemonToken(parsed);
  if (!token) return null;
  const ports = readDaemonInfoPorts(parsed);
  if (!ports) return null;
  return {
    token,
    ...ports,
    transport: readDaemonInfoTransport(parsed.transport),
    pid: readPositiveInteger(parsed.pid) ?? 0,
    version: readOptionalString(parsed.version),
    codeOrigin: readDaemonInfoCodeOrigin(parsed.codeOrigin),
    codeSignature: readOptionalString(parsed.codeSignature),
    policyDigest: readOptionalString(parsed.policyDigest),
    processStartTime: readOptionalNonBlankString(parsed.processStartTime),
    deviceClaimRootId: readOptionalNonBlankString(parsed.deviceClaimRootId),
  };
}

function readRequiredDaemonToken(parsed: Partial<DaemonInfo>): string | null {
  return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
}

function readDaemonInfoPorts(
  parsed: Partial<DaemonInfo>,
): Pick<DaemonInfo, 'port' | 'httpPort'> | null {
  const port = readPositiveInteger(parsed.port);
  const httpPort = readPositiveInteger(parsed.httpPort);
  if (port === undefined && httpPort === undefined) return null;
  return { port, httpPort };
}

function readDaemonInfoCodeOrigin(value: unknown): DaemonInfo['codeOrigin'] {
  return value === 'installed' || value === 'checkout' ? value : undefined;
}

function readDaemonInfoTransport(value: unknown): DaemonInfo['transport'] {
  return value === 'socket' || value === 'http' || value === 'dual' ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNonBlankString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function readDaemonLockInfo(lockPath: string): DaemonLockInfo | null {
  const data = readJsonFile(lockPath);
  if (!data || typeof data !== 'object') return null;
  const parsed = data as Partial<DaemonLockInfo>;
  const hasPid = Number.isInteger(parsed.pid) && Number(parsed.pid) > 0;
  if (!hasPid) {
    return null;
  }
  return {
    pid: Number(parsed.pid),
    processStartTime: readOptionalNonBlankString(parsed.processStartTime),
    startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined,
  };
}

export function isDaemonLockHeldByAnotherDaemon(paths: DaemonPaths, pid: number): boolean {
  const lockInfo = readDaemonLockInfo(paths.lockPath);
  return (
    lockInfo !== null &&
    lockInfo.pid !== pid &&
    isAgentDeviceDaemonProcess(lockInfo.pid, lockInfo.processStartTime)
  );
}

export function cleanupStaleDaemonLockIfSafe(
  paths: DaemonPaths,
  inspectDaemonProcess: typeof inspectAgentDeviceDaemonProcess = inspectAgentDeviceDaemonProcess,
): boolean {
  const release = tryAcquireDaemonLockMutationGuard(paths.lockPath);
  if (!release) return false;
  try {
    const state = getDaemonMetadataState(paths);
    if (!state.hasLock) return true;
    const lockInfo = readDaemonLockInfo(paths.lockPath);
    if (!lockInfo) return false;
    const observation = inspectDaemonProcess(lockInfo.pid, lockInfo.processStartTime);
    if (!canDiscardDaemonMetadata(observation)) return false;
    removeFileIfExists(paths.lockPath);
    return !fs.existsSync(paths.lockPath);
  } finally {
    release();
  }
}

export async function cleanupFailedDaemonStartupMetadata(
  paths: DaemonPaths,
  reason: DaemonStartupCleanupReason,
): Promise<DaemonStartupCleanupResult> {
  const result: DaemonStartupCleanupResult = {
    reason,
    removedInfo: false,
    removedLock: false,
    stoppedInfoProcess: false,
    stoppedLockProcess: false,
  };

  const releaseLockMutation = tryAcquireDaemonLockMutationGuard(paths.lockPath);
  if (!releaseLockMutation) {
    result.retainedInfoProcess = fs.existsSync(paths.infoPath) || undefined;
    // The guard itself is live mutation authority. Even when daemon.lock has not been
    // published yet, another cooperating startup may be inside that critical section.
    result.retainedLockProcess = true;
    result.error = 'Daemon metadata mutation is owned by another process';
  } else {
    try {
      const infoExists = fs.existsSync(paths.infoPath);
      const info = readDaemonInfo(paths.infoPath);
      if (info) {
        const infoOwner = inspectAgentDeviceDaemonProcess(info.pid, info.processStartTime);
        if (infoOwner === 'match') {
          result.retainedInfoProcess = true;
        } else if (infoOwner === 'unknown') {
          result.retainedInfoProcess = true;
          result.error = 'Daemon info process identity could not be verified';
        } else {
          removeFileIfExists(paths.infoPath);
          result.removedInfo = !fs.existsSync(paths.infoPath);
        }
      } else if (infoExists) {
        result.retainedInfoProcess = true;
        result.error = 'Daemon info metadata is malformed and cannot be verified';
      }

      const lockExists = fs.existsSync(paths.lockPath);
      const lockInfo = readDaemonLockInfo(paths.lockPath);
      if (lockInfo) {
        const lockOwner = inspectAgentDeviceDaemonProcess(lockInfo.pid, lockInfo.processStartTime);
        if (lockOwner === 'match') {
          result.retainedLockProcess = true;
        } else if (lockOwner === 'unknown') {
          result.retainedLockProcess = true;
          result.error ??= 'Daemon lock process identity could not be verified';
        } else {
          removeFileIfExists(paths.lockPath);
          result.removedLock = !fs.existsSync(paths.lockPath);
        }
      } else if (lockExists) {
        result.retainedLockProcess = true;
        result.error ??= 'Daemon lock metadata is malformed and cannot be verified';
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    } finally {
      releaseLockMutation();
    }
  }

  emitDiagnostic({
    level: result.error ? 'warn' : 'info',
    phase: 'daemon_startup_metadata_cleanup',
    data: result,
  });
  return result;
}

export function getDaemonMetadataState(paths: DaemonPaths): DaemonMetadataState {
  return {
    hasInfo: fs.existsSync(paths.infoPath),
    hasLock: fs.existsSync(paths.lockPath),
  };
}

export async function recoverDaemonLockHolder(paths: DaemonPaths): Promise<boolean> {
  const release = tryAcquireDaemonLockMutationGuard(paths.lockPath);
  if (!release) return false;
  try {
    const state = getDaemonMetadataState(paths);
    if (!state.hasLock || state.hasInfo) return false;
    const lockInfo = readDaemonLockInfo(paths.lockPath);
    if (!lockInfo) return false;
    const observation = inspectAgentDeviceDaemonProcess(lockInfo.pid, lockInfo.processStartTime);
    if (!canDiscardDaemonMetadata(observation)) return false;
    removeFileIfExists(paths.lockPath);
    return !fs.existsSync(paths.lockPath);
  } finally {
    release();
  }
}

function canDiscardDaemonMetadata(observation: AgentDeviceDaemonProcessObservation): boolean {
  return observation === 'absent' || observation === 'different';
}

async function stopDaemonProcessForTakeover(info: DaemonInfo): Promise<void> {
  await stopProcessForTakeover(info.pid, {
    termTimeoutMs: DAEMON_TAKEOVER_TERM_TIMEOUT_MS,
    killTimeoutMs: DAEMON_TAKEOVER_KILL_TIMEOUT_MS,
    expectedStartTime: info.processStartTime,
  });
}

export async function stopDaemonMetadataOwnerForTakeover(
  paths: Pick<DaemonPaths, 'infoPath' | 'lockPath'>,
  expected: DaemonInfo,
): Promise<{ removedInfo: boolean; removedLock: boolean }> {
  const release = tryAcquireDaemonLockMutationGuard(paths.lockPath);
  if (!release) {
    throw new AppError('COMMAND_FAILED', 'Daemon metadata is being changed by another process', {
      reason: 'daemon_takeover_incomplete',
      phase: 'metadata_mutation',
      lockPath: paths.lockPath,
    });
  }
  try {
    const infoExists = fs.existsSync(paths.infoPath);
    const currentInfo = readDaemonInfo(paths.infoPath);
    if (infoExists && !currentInfo) {
      throw daemonMetadataOwnershipChanged(paths, 'malformed_info');
    }
    if (currentInfo && !sameDaemonProcessIdentity(currentInfo, expected)) {
      throw daemonMetadataOwnershipChanged(paths, 'info_owner_changed');
    }

    const lockExists = fs.existsSync(paths.lockPath);
    const currentLock = readDaemonLockInfo(paths.lockPath);
    if (lockExists && !currentLock) {
      throw daemonMetadataOwnershipChanged(paths, 'malformed_lock');
    }
    if (currentLock && !sameDaemonProcessIdentity(currentLock, expected)) {
      throw daemonMetadataOwnershipChanged(paths, 'lock_owner_changed');
    }

    await stopDaemonProcessForTakeover(expected);
    removeFileIfExists(paths.infoPath);
    removeFileIfExists(paths.lockPath);
    return {
      removedInfo: infoExists && !fs.existsSync(paths.infoPath),
      removedLock: lockExists && !fs.existsSync(paths.lockPath),
    };
  } finally {
    release();
  }
}

function sameDaemonProcessIdentity(
  left: { pid: number; processStartTime?: string },
  right: { pid: number; processStartTime?: string },
): boolean {
  const leftStart = left.processStartTime?.trim();
  const rightStart = right.processStartTime?.trim();
  return left.pid === right.pid && Boolean(leftStart) && leftStart === rightStart;
}

function daemonMetadataOwnershipChanged(
  paths: Pick<DaemonPaths, 'infoPath' | 'lockPath'>,
  phase: 'malformed_info' | 'info_owner_changed' | 'malformed_lock' | 'lock_owner_changed',
): AppError {
  return new AppError('COMMAND_FAILED', 'Daemon metadata ownership changed during takeover', {
    reason: 'daemon_takeover_incomplete',
    phase,
    infoPath: paths.infoPath,
    lockPath: paths.lockPath,
  });
}

export function isRemoteDaemon(info: DaemonInfo): boolean {
  return typeof info.baseUrl === 'string' && info.baseUrl.length > 0;
}

export function resolveDaemonStartupHint(
  state: { hasInfo: boolean; hasLock: boolean },
  paths: Pick<DaemonPaths, 'infoPath' | 'lockPath'> = resolveDaemonPaths(
    process.env.AGENT_DEVICE_STATE_DIR,
  ),
): string {
  const recovery = buildDaemonMetadataRecoveryInstructions(paths);
  if (state.hasLock && !state.hasInfo) {
    return `agent-device attempted to clean stale daemon metadata automatically, but ${paths.lockPath} still exists without ${paths.infoPath}. Retry with --debug. ${recovery}`;
  }
  if (state.hasLock && state.hasInfo) {
    return `agent-device attempted to clean stale daemon metadata automatically, but ${paths.infoPath} and ${paths.lockPath} still remain. Retry with --debug. ${recovery}`;
  }
  if (state.hasInfo) {
    return `agent-device did not observe reachable daemon metadata after retrying, and ${paths.infoPath} still remains. Stale metadata was cleaned automatically when safe; retry with --debug. ${recovery}`;
  }
  return `agent-device did not observe reachable daemon metadata after retrying. Stale metadata was cleaned automatically when safe; retry with --debug and check daemon diagnostics logs. ${recovery}`;
}

function buildDaemonMetadataRecoveryInstructions(
  paths: Pick<DaemonPaths, 'infoPath' | 'lockPath'>,
): string {
  const guardPath = resolveDaemonLockMutationGuardPath(paths.lockPath);
  const removeGuard = `rmdir ${shellQuote(guardPath)}`;
  const removeMetadata = `rm -f ${shellQuote(paths.infoPath)} ${shellQuote(paths.lockPath)}`;
  return (
    `Only after confirming that no agent-device client or daemon is operating on this state ` +
    `directory, remove an orphaned empty mutation guard with: ${removeGuard}. ` +
    `Then remove stale daemon metadata with: ${removeMetadata}`
  );
}

function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function removeFileIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup only.
  }
}
