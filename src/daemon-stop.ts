import {
  supersededClaimWarnings,
  orphanedClaimWarnings,
  unattributableClaimWarnings,
} from './daemon-shutdown-warnings.ts';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import {
  isAgentDeviceDaemonProcess,
  trySignalProcess,
  waitForDaemonExit,
} from './daemon-process.ts';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { sleep } from '@agent-device/host-kit/retry';
import type { DaemonPaths } from './daemon-resolution.ts';
import type {
  DaemonShutdownIdentity,
  DaemonShutdownReport,
  DeviceClaimRecord,
  ProviderReleaseRecord,
} from './daemon-shutdown-report.ts';

const DAEMON_STOP_GRACE_TIMEOUT_MS = 10_000;
const DAEMON_STOP_METADATA_WAIT_MS = 1_000;

type DaemonInfo = {
  pid?: unknown;
  processStartTime?: unknown;
  version?: unknown;
  codeSignature?: unknown;
  deviceClaimRootId?: unknown;
};

export type DaemonStopResult = {
  stopped: boolean;
  mode: 'graceful' | 'grace-timeout' | 'not-running';
  cleanupConfidence: 'known' | 'unknown';
  /**
   * #1320 claim results. Only a graceful stop can carry values: they come from
   * the shutdown report the exiting daemon wrote, so a daemon that was not
   * running or missed its graceful deadline reports none.
   */
  claimsReleased: DeviceClaimRecord[];
  claimsOrphaned: DeviceClaimRecord[];
  /** Claims another owner had already taken over; this daemon released nothing. */
  claimsSuperseded: DeviceClaimRecord[];
  claimsUnattributable: DeviceClaimRecord[];
  providerReleases: {
    status: 'completed' | 'unknown';
    released: ProviderReleaseRecord[];
    pending: ProviderReleaseRecord[] | null;
  };
  warnings: string[];
};

export async function stopDaemon(params: {
  paths: DaemonPaths;
  graceTimeoutMs?: number;
  /** Rechecked immediately before the first signal to close metadata swap races. */
  expectedIdentity?: DaemonShutdownIdentity;
}): Promise<DaemonStopResult> {
  const info = readDaemonInfo(params.paths.infoPath);
  if (!info) return notRunningResult();
  if (params.expectedIdentity && !sameAuthorityIdentity(info, params.expectedIdentity)) {
    throw new AppError('COMMAND_FAILED', 'Refusing to stop a daemon whose authority changed.', {
      reason: 'daemon_authority_identity_changed',
      expected: params.expectedIdentity,
    });
  }
  if (!info.processStartTime) {
    if (!isProcessAlive(info.pid)) return notRunningResult();
    throw new AppError(
      'COMMAND_FAILED',
      'Refusing to stop a daemon without a verified process start-time identity.',
      { pid: info.pid },
    );
  }
  if (!isAgentDeviceDaemonProcess(info.pid, info.processStartTime)) {
    if (!isProcessAlive(info.pid)) return notRunningResult();
    throw new AppError(
      'COMMAND_FAILED',
      'Refusing to stop a daemon whose PID or start-time identity could not be verified.',
      { pid: info.pid, processStartTime: info.processStartTime },
    );
  }

  if (!signalDaemonProcess(info.pid, 'SIGTERM')) return notRunningResult();
  const { exited: graceful } = await waitForDaemonExit(
    { pid: info.pid, startTime: info.processStartTime },
    { timeoutMs: params.graceTimeoutMs ?? DAEMON_STOP_GRACE_TIMEOUT_MS },
  );
  if (graceful) {
    await waitForDaemonMetadataRemoval(params.paths, DAEMON_STOP_METADATA_WAIT_MS);
    return {
      stopped: true,
      mode: 'graceful',
      cleanupConfidence: 'unknown',
      claimsReleased: [],
      claimsOrphaned: [],
      claimsSuperseded: [],
      claimsUnattributable: [],
      providerReleases: { status: 'unknown', released: [], pending: null },
      warnings: [],
    };
  }

  return {
    stopped: false,
    mode: 'grace-timeout',
    cleanupConfidence: 'unknown',
    claimsReleased: [],
    claimsOrphaned: [],
    claimsSuperseded: [],
    claimsUnattributable: [],
    providerReleases: { status: 'unknown', released: [], pending: null },
    warnings: ['The daemon did not exit within the graceful-stop deadline; it was not killed.'],
  };
}

function signalDaemonProcess(pid: number, signal: NodeJS.Signals): boolean {
  if (trySignalProcess(pid, signal)) return true;
  if (!isProcessAlive(pid)) return false;
  throw new AppError('COMMAND_FAILED', `Daemon could not be signaled with ${signal}.`, {
    pid,
    signal,
  });
}

export function readDaemonStopIdentity(
  infoPath: string,
): { pid: number; processStartTime: string } | null {
  const info = readDaemonInfo(infoPath);
  if (!info?.processStartTime) return null;
  return { pid: info.pid, processStartTime: info.processStartTime };
}

export function readDaemonAuthorityIdentity(infoPath: string): DaemonShutdownIdentity | null {
  const info = readDaemonInfo(infoPath);
  if (!info?.processStartTime || !info.version || !info.codeSignature || !info.deviceClaimRootId) {
    return null;
  }
  return {
    pid: info.pid,
    processStartTime: info.processStartTime,
    version: info.version,
    codeSignature: info.codeSignature,
    deviceClaimRootId: info.deviceClaimRootId,
  };
}

export function applyDaemonShutdownReport(
  stopped: DaemonStopResult,
  report: DaemonShutdownReport | null,
  expectedIdentity: DaemonShutdownIdentity | null,
): DaemonStopResult {
  if (stopped.mode !== 'graceful') return stopped;
  if (!report || !expectedIdentity || !sameAuthorityIdentity(report.daemon, expectedIdentity)) {
    return {
      ...stopped,
      cleanupConfidence: 'unknown',
      providerReleases: { status: 'unknown', released: [], pending: null },
      warnings: [
        ...stopped.warnings,
        'The versioned shutdown report is unavailable or does not match the stopped daemon, so cleanup state is unknown.',
      ],
    };
  }
  return {
    ...stopped,
    cleanupConfidence: 'known',
    providerReleases: { status: 'completed', ...report.providerReleases },
    claimsReleased: report.claims.released,
    claimsOrphaned: report.claims.orphaned,
    claimsSuperseded: report.claims.superseded,
    claimsUnattributable: report.claims.unattributable,
    warnings: [
      ...stopped.warnings,
      ...supersededClaimWarnings(report.claims.superseded),
      ...orphanedClaimWarnings(report.claims.orphaned),
      ...unattributableClaimWarnings(report.claims.unattributable),
    ],
  };
}

function readDaemonInfo(infoPath: string): {
  pid: number;
  processStartTime?: string;
  version?: string;
  codeSignature?: string;
  deviceClaimRootId?: string;
} | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as DaemonInfo;
    const pid = parsed.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      ...(hasProcessStartTime(parsed.processStartTime)
        ? { processStartTime: parsed.processStartTime }
        : {}),
      ...(hasProcessStartTime(parsed.version) ? { version: parsed.version } : {}),
      ...(hasProcessStartTime(parsed.codeSignature) ? { codeSignature: parsed.codeSignature } : {}),
      ...(hasProcessStartTime(parsed.deviceClaimRootId)
        ? { deviceClaimRootId: parsed.deviceClaimRootId }
        : {}),
    };
  } catch {
    return null;
  }
}

function hasProcessStartTime(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function waitForDaemonMetadataRemoval(paths: DaemonPaths, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!fs.existsSync(paths.infoPath) && !fs.existsSync(paths.lockPath)) return;
    await sleep(25);
  }
}

function notRunningResult(): DaemonStopResult {
  return {
    stopped: false,
    mode: 'not-running',
    cleanupConfidence: 'unknown',
    claimsReleased: [],
    claimsOrphaned: [],
    claimsSuperseded: [],
    claimsUnattributable: [],
    providerReleases: { status: 'unknown', released: [], pending: null },
    warnings: [],
  };
}

function sameAuthorityIdentity(
  actual: ReturnType<typeof readDaemonInfo>,
  expected: DaemonShutdownIdentity,
): boolean {
  return (
    actual !== null &&
    actual.pid === expected.pid &&
    actual.processStartTime === expected.processStartTime &&
    actual.version === expected.version &&
    actual.codeSignature === expected.codeSignature &&
    actual.deviceClaimRootId === expected.deviceClaimRootId
  );
}
