import {
  runnerSessionPinned,
  sameRunnerRecordingAuthority,
  type RunnerSession,
  type RunnerRecordingAuthority,
  type RunnerRecordingPin,
} from './runner-session-types.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from './host.ts';
import {
  runnerSessions,
  withRunnerSessionLock,
  discardSimulatorRunnerContainerCache,
} from './runner-session-registry.ts';
import { writeRunnerLease, withRunnerLeaseLock } from './runner-lease.ts';
import {
  isRunnerProcessAlive,
  disposeRunnerSession,
  RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
} from './runner-disposal.ts';
import {
  cancelIosRunnerIdleStop,
  type RunnerSessionOptions,
  runnerSessionOwnershipChanged,
} from './runner-session.ts';
export function getRunnerSessionSnapshot(deviceId: string): {
  sessionId: string;
  alive: boolean;
  launchIdentity: RunnerSession['launchIdentity'];
  recordingAuthority?: RunnerRecordingAuthority;
} | null {
  const session = runnerSessions.get(deviceId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    alive: isRunnerProcessAlive(session.child.pid),
    launchIdentity: session.launchIdentity,
    ...(session.recordingPin ? { recordingAuthority: session.recordingPin.authority } : {}),
  };
}

export async function acquireRunnerRecordingPin(
  device: DeviceInfo,
  request: Readonly<{ startCommandId: string; remotePath?: string }>,
  options: RunnerSessionOptions,
): Promise<RunnerRecordingAuthority> {
  const { ensureRunnerSession } = await import('./runner-session.ts');
  const candidate = await ensureRunnerSession(device, options);
  return await withRunnerSessionLock(device.id, async () => {
    const session = runnerSessions.get(device.id);
    if (session !== candidate || !isRunnerProcessAlive(session.child.pid)) {
      throw runnerSessionOwnershipChanged();
    }
    if (session.recordingPin) throw runnerSessionPinned(session);
    const authority = Object.freeze({
      runnerSessionId: session.sessionId,
      launchIdentity: Object.freeze({ ...session.launchIdentity }),
      startCommandId: request.startCommandId,
      ...(request.remotePath === undefined ? {} : { remotePath: request.remotePath }),
    });
    persistRunnerRecordingPin(session, { authority, state: 'nonfinalized' });
    return authority;
  });
}

export async function assertRunnerRecordingAuthority(
  deviceId: string,
  authority: RunnerRecordingAuthority,
): Promise<RunnerRecordingPin['state']> {
  return await withRunnerSessionLock(deviceId, async () => {
    return requirePinnedRunnerSession(deviceId, authority).recordingPin!.state;
  });
}

export async function updateRunnerRecordingPin(
  deviceId: string,
  authority: RunnerRecordingAuthority,
  state: RunnerRecordingPin['state'],
): Promise<void> {
  await withRunnerSessionLock(deviceId, async () => {
    const session = requirePinnedRunnerSession(deviceId, authority);
    assertRunnerRecordingTransition(session.recordingPin!.state, state);
    persistRunnerRecordingPin(session, { ...session.recordingPin!, state });
  });
}

function assertRunnerRecordingTransition(
  current: RunnerRecordingPin['state'],
  next: RunnerRecordingPin['state'],
): void {
  if (current === next || (current === 'nonfinalized' && next === 'finalized')) {
    return;
  }
  throw new AppError('COMMAND_FAILED', 'Invalid iOS runner recording state transition', {
    reason: 'runner_recording_transition_invalid',
    currentState: current,
    requestedState: next,
  });
}

export async function releaseRunnerRecordingPin(
  deviceId: string,
  authority: RunnerRecordingAuthority,
  reason: 'retrieved' | 'abandoned',
): Promise<void> {
  await withRunnerSessionLock(deviceId, async () => {
    const session = requirePinnedRunnerSession(deviceId, authority);
    if (session.recordingPin?.state !== 'finalized') {
      throw new AppError(
        'COMMAND_FAILED',
        'The iOS runner recording cannot be released before stop is confirmed',
        { reason: 'runner_recording_not_finalized', sessionId: session.sessionId },
      );
    }
    persistRunnerRecordingPin(session, undefined);
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_recording_pin_released',
      data: { deviceId, sessionId: session.sessionId, reason },
    });
  });
}

export async function rollbackRunnerRecordingPin(
  deviceId: string,
  authority: RunnerRecordingAuthority,
): Promise<void> {
  await withRunnerSessionLock(deviceId, async () => {
    const session = requirePinnedRunnerSession(deviceId, authority);
    if (session.recordingPin?.state !== 'nonfinalized') {
      throw new AppError(
        'COMMAND_FAILED',
        'Only an unattempted recording start can be rolled back',
        {
          reason: 'runner_recording_rollback_refused',
          sessionId: session.sessionId,
          recordingState: session.recordingPin?.state,
        },
      );
    }
    persistRunnerRecordingPin(session, undefined);
  });
}

export async function disposeRunnerAfterRejectedRecordingStart(
  deviceId: string,
  authority: RunnerRecordingAuthority,
): Promise<void> {
  cancelIosRunnerIdleStop(deviceId);
  await withRunnerSessionLock(deviceId, async () => {
    await withRunnerLeaseLock(deviceId, async () => {
      const session = requirePinnedRunnerSession(deviceId, authority);
      if (session.recordingPin?.state !== 'nonfinalized') {
        throw new AppError(
          'COMMAND_FAILED',
          'Only a nonfinalized recording start may force runner disposal',
          {
            reason: 'runner_recording_disposal_refused',
            sessionId: session.sessionId,
            recordingState: session.recordingPin?.state,
          },
        );
      }

      // Keep the exact recording pin in memory and in the durable lease throughout disposal.
      // If disposal fails, the pin remains the reuse fence; no concurrent ensure/start can adopt
      // a runner that may still own the native recording rejected as already active.
      await disposeRunnerSession(session, {
        graceful: false,
        waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
        requireConfirmedExit: true,
        leaseLockHeld: true,
      });
      discardSimulatorRunnerContainerCache(session.deviceId, session.sessionId);
      if (runnerSessions.get(deviceId) === session) {
        runnerSessions.delete(deviceId);
      }
    });
  });
}

function requirePinnedRunnerSession(
  deviceId: string,
  authority: RunnerRecordingAuthority,
): RunnerSession {
  const session = runnerSessions.get(deviceId);
  if (
    !session ||
    !session.recordingPin ||
    !sameRunnerRecordingAuthority(session.recordingPin.authority, authority)
  ) {
    throw runnerSessionOwnershipChanged();
  }
  return session;
}

function persistRunnerRecordingPin(
  session: RunnerSession,
  recordingPin: RunnerRecordingPin | undefined,
): void {
  const lease = session.lease;
  if (!lease) {
    throw new AppError('COMMAND_FAILED', 'The iOS runner has no durable lease', {
      reason: 'runner_lease_missing',
      sessionId: session.sessionId,
    });
  }
  const updatedLease = { ...lease, recordingPin };
  writeRunnerLease(updatedLease);
  session.lease = updatedLease;
  session.recordingPin = recordingPin;
}
