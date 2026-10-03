import fs from 'node:fs';
import path from 'node:path';
import type { DeviceLease } from '@agent-device/contracts/device';
import { publishFileSync } from '@agent-device/host-kit/file';

const SHUTDOWN_REPORT_FILE = 'daemon-shutdown.json';
export const DAEMON_SHUTDOWN_REPORT_SCHEMA_VERSION = 2 as const;

export type DaemonShutdownIdentity = {
  pid: number;
  processStartTime: string;
  version: string;
  codeSignature: string;
  deviceClaimRootId: string;
};

export type ProviderReleaseRecord = {
  leaseId: string;
  provider?: string;
};

/**
 * #1320: what happened to one session's device claim during graceful teardown.
 * `released` means the claim was confirmed gone after the session reached a safe
 * terminal state; `orphaned` means teardown left it in place, so the exiting
 * daemon's dead owner identity is what later proves it reclaimable; `superseded`
 * means another owner had already replaced it, so this daemon released nothing
 * and left nothing to reconcile; `unattributable` means a record is still there
 * that names no owner at all, which neither of the other two describes — see
 * `DaemonShutdownClaims.unattributable`.
 */
export type DeviceClaimRecord = {
  deviceKey: string;
  session: string;
  platform: string;
  deviceId: string;
};

export type DaemonShutdownReport = {
  schemaVersion: typeof DAEMON_SHUTDOWN_REPORT_SCHEMA_VERSION;
  daemon: DaemonShutdownIdentity;
  providerReleases: {
    released: ProviderReleaseRecord[];
    pending: ProviderReleaseRecord[];
  };
  claims: {
    released: DeviceClaimRecord[];
    orphaned: DeviceClaimRecord[];
    superseded: DeviceClaimRecord[];
    unattributable: DeviceClaimRecord[];
  };
};

export function writeDaemonShutdownReport(
  stateDir: string,
  outcome: {
    daemon: DaemonShutdownIdentity;
    providerReleases: { released: readonly DeviceLease[]; pending: readonly DeviceLease[] };
    claims: {
      released: readonly DeviceClaimRecord[];
      orphaned: readonly DeviceClaimRecord[];
      superseded: readonly DeviceClaimRecord[];
      unattributable: readonly DeviceClaimRecord[];
    };
  },
): void {
  const report: DaemonShutdownReport = {
    schemaVersion: DAEMON_SHUTDOWN_REPORT_SCHEMA_VERSION,
    daemon: outcome.daemon,
    providerReleases: {
      released: outcome.providerReleases.released.map(toProviderReleaseRecord),
      pending: outcome.providerReleases.pending.map(toProviderReleaseRecord),
    },
    claims: {
      released: [...outcome.claims.released],
      orphaned: [...outcome.claims.orphaned],
      superseded: [...outcome.claims.superseded],
      unattributable: [...outcome.claims.unattributable],
    },
  };
  const filePath = shutdownReportPath(stateDir);
  try {
    publishFileSync({
      destination: filePath,
      contents: `${JSON.stringify(report)}\n`,
      mode: 0o600,
    });
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Shutdown reporting is best effort; the atomic publisher has already
    // preserved the primary filesystem failure and cleaned its temp sibling.
  }
}

export function readDaemonShutdownReport(stateDir: string): DaemonShutdownReport | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(shutdownReportPath(stateDir), 'utf8')) as unknown;
    return parseDaemonShutdownReport(parsed);
  } catch {
    return null;
  }
}

/** Strict v2 decoder. Pre-v2 and partially valid reports fail closed. */
export function parseDaemonShutdownReport(value: unknown): DaemonShutdownReport | null {
  if (!hasExactKeys(value, ['schemaVersion', 'daemon', 'providerReleases', 'claims'])) return null;
  if (value.schemaVersion !== DAEMON_SHUTDOWN_REPORT_SCHEMA_VERSION) return null;
  if (!isDaemonShutdownIdentity(value.daemon)) return null;
  if (!hasExactKeys(value.providerReleases, ['released', 'pending'])) return null;
  if (!hasExactKeys(value.claims, ['released', 'orphaned', 'superseded', 'unattributable']))
    return null;
  if (
    !isRecordArray(value.providerReleases.released, isProviderReleaseRecord) ||
    !isRecordArray(value.providerReleases.pending, isProviderReleaseRecord) ||
    !isRecordArray(value.claims.released, isDeviceClaimRecord) ||
    !isRecordArray(value.claims.orphaned, isDeviceClaimRecord) ||
    !isRecordArray(value.claims.superseded, isDeviceClaimRecord) ||
    !isRecordArray(value.claims.unattributable, isDeviceClaimRecord)
  ) {
    return null;
  }
  return value as DaemonShutdownReport;
}

export function clearDaemonShutdownReport(stateDir: string): void {
  try {
    fs.rmSync(shutdownReportPath(stateDir), { force: true });
  } catch {}
}

function shutdownReportPath(stateDir: string): string {
  return path.join(stateDir, SHUTDOWN_REPORT_FILE);
}

function toProviderReleaseRecord(lease: DeviceLease): ProviderReleaseRecord {
  return {
    leaseId: lease.leaseId,
    ...(lease.leaseProvider ? { provider: lease.leaseProvider } : {}),
  };
}

function isDeviceClaimRecord(value: unknown): value is DeviceClaimRecord {
  if (!hasExactKeys(value, ['deviceKey', 'session', 'platform', 'deviceId'])) return false;
  const record = value as Partial<Record<keyof DeviceClaimRecord, unknown>>;
  return (
    typeof record.deviceKey === 'string' &&
    typeof record.session === 'string' &&
    typeof record.platform === 'string' &&
    typeof record.deviceId === 'string'
  );
}

function isProviderReleaseRecord(value: unknown): value is ProviderReleaseRecord {
  if (!hasOnlyKeys(value, ['leaseId', 'provider'], ['leaseId'])) return false;
  const record = value as { leaseId?: unknown; provider?: unknown };
  return (
    typeof record.leaseId === 'string' &&
    record.leaseId.trim().length > 0 &&
    (record.provider === undefined || typeof record.provider === 'string')
  );
}

function isDaemonShutdownIdentity(value: unknown): value is DaemonShutdownIdentity {
  if (
    !hasExactKeys(value, [
      'pid',
      'processStartTime',
      'version',
      'codeSignature',
      'deviceClaimRootId',
    ])
  ) {
    return false;
  }
  return (
    typeof value.pid === 'number' &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    isNonBlank(value.processStartTime) &&
    isNonBlank(value.version) &&
    isNonBlank(value.codeSignature) &&
    isNonBlank(value.deviceClaimRootId)
  );
}

function isRecordArray<T>(value: unknown, guard: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

function hasExactKeys<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  return hasOnlyKeys(value, keys, keys);
}

function hasOnlyKeys<K extends string>(
  value: unknown,
  allowed: readonly K[],
  required: readonly K[],
): value is Partial<Record<K, unknown>> & Record<K, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.every((key) => allowed.includes(key as K)) && required.every((key) => key in value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
