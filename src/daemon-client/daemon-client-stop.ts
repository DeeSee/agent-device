import type {
  StopLocalDaemonInput,
  AgentDeviceDaemonCleanupEvidence,
  AgentDeviceDaemonCleanupResult,
  AgentDeviceDaemonIdentity,
  AgentDeviceDaemonStopResult,
} from '@agent-device/contracts/client';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { openDeviceClaimRoot } from '../device-claim-root.ts';
import { resolveDaemonPaths } from '../daemon-resolution.ts';
import { readDaemonAuthorityIdentity, stopDaemon, type DaemonStopResult } from '../daemon-stop.ts';
import {
  readDaemonShutdownReport,
  type DaemonShutdownIdentity,
  type DaemonShutdownReport,
} from '../daemon-shutdown-report.ts';

export type StopLocalDaemonEffects = Readonly<{
  infoExists: (infoPath: string) => boolean;
  readIdentity: (infoPath: string) => DaemonShutdownIdentity | null;
  resolveClaimRootId: (deviceClaimsDir: string) => string;
  stopProcess: typeof stopDaemon;
  readReport: typeof readDaemonShutdownReport;
}>;

const DEFAULT_EFFECTS: StopLocalDaemonEffects = {
  infoExists: (infoPath) => fs.existsSync(infoPath),
  readIdentity: readDaemonAuthorityIdentity,
  resolveClaimRootId: (deviceClaimsDir) => openDeviceClaimRoot(deviceClaimsDir).id,
  stopProcess: stopDaemon,
  readReport: readDaemonShutdownReport,
};

/** Gracefully stops one construction-bound local daemon and seals its cleanup evidence. */
export async function stopLocalDaemon(
  input: StopLocalDaemonInput,
  effects: StopLocalDaemonEffects = DEFAULT_EFFECTS,
): Promise<AgentDeviceDaemonStopResult> {
  assertExplicitPath(input.stateDir, 'stateDir');
  assertExplicitPath(input.deviceClaimsDir, 'deviceClaimsDir');
  const paths = resolveDaemonPaths(input.stateDir);
  const expectedClaimRootId = effects.resolveClaimRootId(input.deviceClaimsDir);
  if (!effects.infoExists(paths.infoPath)) return notRunningResult();

  const identity = effects.readIdentity(paths.infoPath);
  if (!identity) {
    throw new AppError(
      'COMMAND_FAILED',
      'Refusing to stop a daemon without a complete authority identity.',
      { reason: 'daemon_authority_identity_incomplete' },
    );
  }
  if (identity.deviceClaimRootId !== expectedClaimRootId) {
    throw new AppError('COMMAND_FAILED', 'Refusing to stop a daemon for another claim root.', {
      reason: 'daemon_claim_root_mismatch',
      expectedClaimRootId,
      actualClaimRootId: identity.deviceClaimRootId,
    });
  }

  const processResult = await effects.stopProcess({
    paths,
    expectedIdentity: identity,
  });
  return mapProcessResult(processResult, identity, () => effects.readReport(paths.baseDir));
}

function mapProcessResult(
  processResult: DaemonStopResult,
  identity: DaemonShutdownIdentity,
  readReport: () => DaemonShutdownReport | null,
): AgentDeviceDaemonStopResult {
  if (processResult.mode === 'not-running') return notRunningResult();
  if (processResult.mode === 'grace-timeout') {
    return {
      kind: 'still_running',
      mode: 'grace_timeout',
      identity,
      cleanup: { kind: 'unknown', reason: 'grace_timeout' },
    };
  }
  return {
    kind: 'stopped',
    mode: 'graceful',
    identity,
    cleanup: cleanupFromReport(identity, readReport()),
  };
}

function cleanupFromReport(
  expected: DaemonShutdownIdentity,
  report: DaemonShutdownReport | null,
): AgentDeviceDaemonCleanupResult {
  if (!report) {
    return { kind: 'unknown', reason: 'shutdown_report_unavailable_or_invalid' };
  }
  if (!sameIdentity(expected, report.daemon)) {
    return { kind: 'unknown', reason: 'shutdown_report_identity_mismatch' };
  }
  const evidence: AgentDeviceDaemonCleanupEvidence = {
    providerReleases: report.providerReleases,
    claims: report.claims,
  };
  const reasons: (
    | 'provider_releases_pending'
    | 'device_claims_orphaned'
    | 'device_claims_unattributable'
  )[] = [];
  if (report.providerReleases.pending.length > 0) reasons.push('provider_releases_pending');
  if (report.claims.orphaned.length > 0) reasons.push('device_claims_orphaned');
  if (report.claims.unattributable.length > 0) reasons.push('device_claims_unattributable');
  return reasons.length === 0
    ? { kind: 'complete', evidence }
    : { kind: 'incomplete', reasons, evidence };
}

function sameIdentity(left: AgentDeviceDaemonIdentity, right: AgentDeviceDaemonIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.processStartTime === right.processStartTime &&
    left.version === right.version &&
    left.codeSignature === right.codeSignature &&
    left.deviceClaimRootId === right.deviceClaimRootId
  );
}

function notRunningResult(): AgentDeviceDaemonStopResult {
  return {
    kind: 'not_running',
    mode: 'not_running',
    identity: null,
    cleanup: { kind: 'unknown', reason: 'daemon_not_running' },
  };
}

function assertExplicitPath(value: string, name: string): void {
  if (value.trim().length > 0) return;
  throw new AppError('INVALID_ARGS', `${name} must be an explicit non-empty path.`);
}
