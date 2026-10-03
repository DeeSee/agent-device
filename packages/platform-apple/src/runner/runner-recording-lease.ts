import { isProcessAlive } from './host.ts';
import { AppError } from '@agent-device/kernel/errors';

import type { ManagedProcessOwnership } from '@agent-device/contracts/platform-runtime-host';
import {
  sameRunnerLaunchIdentity,
  sameRunnerRecordingAuthority,
  type RunnerRecordingAuthority,
} from './runner-session-types.ts';
import {
  readRunnerLease,
  classifyRunnerLease,
  withRunnerLeaseLock,
  writeRunnerLease,
  verifyLeaseRunnerPidIdentity,
  type RunnerLease,
} from './runner-lease.ts';
export type RecoverableRunnerRecordingLease = Readonly<{
  port: number;
  testHostContainerBundleId: string;
  artifactSource: RunnerLease['artifactSource'];
}>;

export async function reconcileOrphanRunnerRecordingLease(
  deviceId: string,
  effect: (
    lease: RecoverableRunnerRecordingLease &
      Readonly<{ recordingAuthority: RunnerRecordingAuthority }>,
  ) => Promise<void>,
): Promise<'missing' | 'reconciled'> {
  return await withRunnerLeaseLock(deviceId, async () => {
    const state = classifyRunnerLease(readRunnerLease(deviceId));
    if (state.type === 'empty') return 'missing';
    if (
      state.type === 'busy' ||
      (state.type === 'stale' && state.staleReason === 'owner-state-dir-gone')
    ) {
      throw runnerRecordingOwnershipChanged(deviceId);
    }
    const lease = state.lease;
    const pin = lease.recordingPin;
    if (!pin) return 'missing';
    if (pin.state === 'nonfinalized' && isLeasedRunnerAlive(lease)) {
      await effect({
        ...toRecoverableRunnerRecordingLease(lease),
        recordingAuthority: pin.authority,
      });
    }
    clearExactRunnerRecordingPin(lease, pin.authority);
    return 'reconciled';
  });
}

export async function inspectRecoverableRunnerRecordingLease(
  deviceId: string,
  authority: RunnerRecordingAuthority,
): Promise<ManagedProcessOwnership> {
  return await withRunnerLeaseLock(deviceId, async () => {
    const resolved = resolveRecoverableRunnerRecordingLease(deviceId, authority);
    if (resolved.status !== 'exact') return resolved.status;
    if (!isLeasedRunnerAlive(resolved.lease)) {
      clearExactRunnerRecordingPin(resolved.lease, authority);
      return 'missing';
    }
    return 'owned-alive';
  });
}

export async function finalizeRecoverableRunnerRecordingLease(
  deviceId: string,
  authority: RunnerRecordingAuthority,
  effect: (lease: RecoverableRunnerRecordingLease) => Promise<void>,
): Promise<'finalized' | 'missing'> {
  return await withRunnerLeaseLock(deviceId, async () => {
    const resolved = requireRecoverableRunnerRecordingLease(deviceId, authority);
    if (resolved.status === 'missing') return 'missing';
    const pin = resolved.lease.recordingPin!;
    if (pin.state === 'finalized') return 'finalized';
    if (!isLeasedRunnerAlive(resolved.lease)) {
      clearExactRunnerRecordingPin(resolved.lease, authority);
      return 'missing';
    }
    await effect(toRecoverableRunnerRecordingLease(resolved.lease));
    writeRunnerLease({
      ...resolved.lease,
      recordingPin: Object.freeze({ ...pin, state: 'finalized' }),
    });
    return 'finalized';
  });
}

export async function retrieveRecoverableRunnerRecordingLease(
  deviceId: string,
  authority: RunnerRecordingAuthority,
  effect: (
    lease: RecoverableRunnerRecordingLease & Readonly<{ remotePath: string }>,
  ) => Promise<void>,
): Promise<'retrieved' | 'missing'> {
  return await withRunnerLeaseLock(deviceId, async () => {
    const resolved = requireRecoverableRunnerRecordingLease(deviceId, authority);
    if (resolved.status === 'missing') return 'missing';
    const pin = resolved.lease.recordingPin!;
    if (pin.state !== 'finalized') throw runnerRecordingNotFinalized(resolved.lease);
    if (!authority.remotePath) {
      throw new AppError('COMMAND_FAILED', 'The recording authority has no remote media path', {
        reason: 'runner_recording_remote_path_missing',
        sessionId: resolved.lease.sessionId,
      });
    }
    await effect({
      ...toRecoverableRunnerRecordingLease(resolved.lease),
      remotePath: authority.remotePath,
    });
    clearExactRunnerRecordingPin(resolved.lease, authority);
    return 'retrieved';
  });
}

export async function releaseRecoverableRunnerRecordingLease(
  deviceId: string,
  authority: RunnerRecordingAuthority,
): Promise<'released' | 'missing'> {
  return await withRunnerLeaseLock(deviceId, async () => {
    const resolved = requireRecoverableRunnerRecordingLease(deviceId, authority);
    if (resolved.status === 'missing') return 'missing';
    if (resolved.lease.recordingPin?.state !== 'finalized') {
      throw runnerRecordingNotFinalized(resolved.lease);
    }
    clearExactRunnerRecordingPin(resolved.lease, authority);
    return 'released';
  });
}

function resolveRecoverableRunnerRecordingLease(
  deviceId: string,
  authority: RunnerRecordingAuthority,
):
  | Readonly<{ status: 'exact'; lease: RunnerLease }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'ownership-lost' }> {
  const state = classifyRunnerLease(readRunnerLease(deviceId));
  if (state.type === 'empty') return { status: 'missing' };
  if (
    state.type === 'busy' ||
    (state.type === 'stale' && state.staleReason === 'owner-state-dir-gone')
  ) {
    return { status: 'ownership-lost' };
  }
  const lease = state.lease;
  if (
    lease.sessionId !== authority.runnerSessionId ||
    !sameRunnerLaunchIdentity(lease.launchIdentity, authority.launchIdentity)
  ) {
    return { status: 'ownership-lost' };
  }
  if (!lease.recordingPin) return { status: 'missing' };
  return sameRunnerRecordingAuthority(lease.recordingPin.authority, authority)
    ? { status: 'exact', lease }
    : { status: 'ownership-lost' };
}

function requireRecoverableRunnerRecordingLease(
  deviceId: string,
  authority: RunnerRecordingAuthority,
): Readonly<{ status: 'exact'; lease: RunnerLease }> | Readonly<{ status: 'missing' }> {
  const resolved = resolveRecoverableRunnerRecordingLease(deviceId, authority);
  if (resolved.status === 'ownership-lost') throw runnerRecordingOwnershipChanged(deviceId);
  return resolved;
}

function isLeasedRunnerAlive(lease: RunnerLease): boolean {
  return (
    lease.runnerPid !== null &&
    isProcessAlive(lease.runnerPid) &&
    verifyLeaseRunnerPidIdentity(lease, lease.runnerPid)
  );
}

function toRecoverableRunnerRecordingLease(lease: RunnerLease): RecoverableRunnerRecordingLease {
  return Object.freeze({
    port: lease.port,
    testHostContainerBundleId: lease.launchIdentity.testHostContainerBundleId,
    artifactSource: lease.artifactSource,
  });
}

function clearExactRunnerRecordingPin(
  lease: RunnerLease,
  authority: RunnerRecordingAuthority,
): void {
  if (
    !lease.recordingPin ||
    !sameRunnerRecordingAuthority(lease.recordingPin.authority, authority)
  ) {
    throw runnerRecordingOwnershipChanged(lease.deviceId);
  }
  const { recordingPin: _recordingPin, ...releasedLease } = lease;
  writeRunnerLease(releasedLease);
}

function runnerRecordingOwnershipChanged(deviceId: string): AppError {
  return new AppError('COMMAND_FAILED', 'The iOS runner recording ownership changed', {
    reason: 'runner_session_ownership_changed',
    deviceId,
  });
}

function runnerRecordingNotFinalized(lease: RunnerLease): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'The iOS runner recording cannot be released before stop is confirmed',
    {
      reason: 'runner_recording_not_finalized',
      sessionId: lease.sessionId,
      recordingState: lease.recordingPin?.state,
    },
  );
}
