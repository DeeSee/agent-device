import { resolveRunnerLaunchSelection, type RunnerLaunchSelection } from './runner-xctestrun.ts';
import {
  runnerSessionPinned,
  sameRunnerLaunchIdentity,
  type RunnerExecutionReceipt,
  advanceRunnerSessionState,
  canWorkWithRunnerSession,
  isRunnerMainThreadOccupied,
  resolveRunnerDetachDecision,
  resolveRunnerSessionLiveness,
  type RunnerDetachRefusal,
  type RunnerSession,
  type RunnerSessionLiveness,
  type RunnerSessionRegistration,
} from './runner-session-types.ts';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from './host.ts';

import { isApplePlatform, type DeviceInfo } from '@agent-device/kernel/device';
import {
  resolveRunnerHandoffTarget,
  type RunnerHandoffLane,
  type RunnerHandoffRefusal,
} from './apple-runner-platform.ts';

import type { AppleRunnerLifecycleOptions } from './runner-provider.ts';

import type { RunnerCommand } from './runner-contract.ts';

import { isRunnerReadinessProbeCommand } from './runner-command-traits.ts';
import { buildDetachedRunnerLease, withRunnerLeaseLock, writeRunnerLease } from './runner-lease.ts';
import { isIosRunnerDetachEnabled } from './runner-adoption.ts';
import {
  abortRunnerSessionsAndPrepProcesses,
  cleanupOwnedIosRunnerLease,
  disposeRunnerSession,
  isRunnerProcessAlive,
  RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
  stopRunnerPrepProcesses,
  type RunnerDisposalOptions,
} from './runner-disposal.ts';

import { isSameRunnerSimulator } from './runner-device-set.ts';

export type { RunnerSession } from './runner-session-types.ts';

export type RunnerSessionOptions = AppleRunnerLifecycleOptions;

import {
  runnerSessions,
  runnerIdleStopTimers,
  withRunnerSessionLock,
  discardSimulatorRunnerContainerCache,
} from './runner-session-registry.ts';
const RUNNER_RETAINED_IDLE_STOP_DEFAULT_MS = 5 * 60_000;

export async function ensureRunnerSession(
  device: DeviceInfo,
  options: RunnerSessionOptions,
  startConstraints: Readonly<{ excludedPort?: number }> = {},
): Promise<RunnerSession> {
  // Any runner use means the device is active again: a pending idle stop
  // from a retained-after-close runner no longer applies.
  cancelIosRunnerIdleStop(device.id);
  const start = withRunnerSessionLock(device.id, async () => {
    const { openRunnerStartBudget } = await import('./runner-start-budget.ts');
    // One budget for the whole start, opened once the lock is held so a start queued behind
    // another does not spend its clock waiting: the reuse check's toolchain probes, adoption and
    // the startup itself all read it. The request's cancellation rides with it, so a client
    // disconnect kills the blocking xctestrun build and runner launch (killProcessTree via exec)
    // instead of orphaning them; a caller's own deadline does not, so the start it interrupts is
    // still there for the retry (#2894). A start that outlives its caller is still bounded: once
    // the budget is spent the same signal ends it, the lock is released and the device is usable.
    const budget = openRunnerStartBudget(options);
    try {
      const existing = runnerSessions.get(device.id);
      if (options.expectedRunnerSessionId !== undefined) {
        if (!existing) throw runnerSessionOwnershipChanged();
        assertExpectedRunnerSession(
          existing,
          options.expectedRunnerSessionId,
          options.expectedRunnerLaunchIdentity,
        );
        if (!isRunnerProcessAlive(existing.child.pid) || !canWorkWithRunnerSession(existing))
          throw runnerSessionOwnershipChanged();
        return existing;
      }
      const requestedSelection = await resolveRunnerLaunchSelection(device, options, budget.phase);
      if (existing) {
        const reusable = await resolveReusableRunnerSession(device, existing, requestedSelection);
        if (reusable) return reusable;
      }

      const { startRunnerSessionWithLease } = await import('./runner-session-launch.ts');
      return await withRunnerLeaseLock(
        device.id,
        async () =>
          await startRunnerSessionWithLease(
            device,
            options,
            budget,
            requestedSelection,
            startConstraints,
          ),
      );
    } catch (error) {
      throw budget.exhausted.aborted ? budget.exhausted.reason : error;
    } finally {
      budget.close();
    }
  });
  const { raceRunnerStartAgainstCaller } = await import('./runner-start-budget.ts');
  return await raceRunnerStartAgainstCaller(start, options.signal);
}

/** How long the device-readiness probe may take, bounded by the startup budget it runs inside. */

export function assertExpectedRunnerSession(
  session: Pick<RunnerSession, 'sessionId' | 'launchIdentity'>,
  expectedRunnerSessionId: string | undefined,
  expectedRunnerLaunchIdentity?: RunnerExecutionReceipt['launchIdentity'],
): void {
  if (
    (expectedRunnerSessionId !== undefined && session.sessionId !== expectedRunnerSessionId) ||
    (expectedRunnerLaunchIdentity !== undefined &&
      !sameRunnerLaunchIdentity(session.launchIdentity, expectedRunnerLaunchIdentity))
  ) {
    throw runnerSessionOwnershipChanged();
  }
}

export function assertRunnerSessionMayStart(expectedRunnerSessionId: string | undefined): void {
  if (expectedRunnerSessionId !== undefined) throw runnerSessionOwnershipChanged();
}

export function runnerSessionOwnershipChanged(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Apple runner session ownership changed before command dispatch',
    { reason: 'runner_session_ownership_changed' },
  );
}

/** Whether a registered session can serve this device; one that cannot is stopped when it must be. */
async function isRunnerSessionServing(
  device: DeviceInfo,
  existing: RunnerSession,
): Promise<boolean> {
  const liveness = readRunnerSessionLivenessFor(existing);
  if (liveness === 'gone') {
    await measureRunnerStartupStep({}, 'stop_stale_session', async () => {
      await stopRunnerSessionInternal(device.id, existing, {
        graceful: false,
        waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
      });
    });
    return false;
  }
  // A registered session already being taken down or already handed off is not usable, even when
  // its runner process is still there for a moment while disposal works.
  if (liveness !== 'starting' && liveness !== 'ready') return false;
  if (liveness === 'starting' && existing.launchDeadline?.isExpired()) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_session_invalidated',
      data: {
        deviceId: device.id,
        sessionId: existing.sessionId,
        reason: 'runner_launch_budget_exhausted',
      },
    });
    await measureRunnerStartupStep({}, 'stop_expired_starting_session', async () => {
      await stopRunnerSessionInternal(device.id, existing, {
        graceful: false,
        waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
      });
    });
    return false;
  }
  if (isSameRunnerSimulator(existing.device, device)) return true;
  await measureRunnerStartupStep({}, 'stop_other_simulator_set_session', async () => {
    await stopRunnerSessionInternal(device.id, existing);
  });
  return false;
}

async function resolveReusableRunnerSession(
  device: DeviceInfo,
  existing: RunnerSession,
  requestedSelection: RunnerLaunchSelection,
): Promise<RunnerSession | null> {
  if (!(await isRunnerSessionServing(device, existing))) return null;
  if (sameRunnerLaunchIdentity(existing.launchIdentity, requestedSelection.identity))
    return existing;
  if (existing.recordingPin) throw runnerSessionPinned(existing);
  emitDiagnostic({
    level: 'info',
    phase: 'ios_runner_session_selector_changed',
    data: {
      deviceId: device.id,
      sessionId: existing.sessionId,
      currentSelectorFingerprint: existing.launchIdentity.selectorFingerprint,
      requestedSelectorFingerprint: requestedSelection.identity.selectorFingerprint,
    },
  });
  await stopRunnerSessionInternal(device.id, existing);
  return null;
}

/**
 * The one reader of what is registered for a device: the session's state plus the one fact the
 * session cannot know itself — whether its runner process is still there. `null` means nothing is
 * registered, which is its own answer: there is no session to wait for or tear down.
 */
export function readRunnerSessionLiveness(deviceId: string): RunnerSessionRegistration | null {
  const session = runnerSessions.get(deviceId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    liveness: readRunnerSessionLivenessFor(session),
  };
}

function readRunnerSessionLivenessFor(session: RunnerSession): RunnerSessionLiveness {
  return resolveRunnerSessionLiveness({
    state: session.state,
    processRunning: isRunnerProcessAlive(session.child.pid),
  });
}

export async function invalidateRunnerSession(
  session: RunnerSession,
  reason: string,
): Promise<void> {
  await withRunnerSessionLock(session.deviceId, async () => {
    if (runnerSessions.get(session.deviceId) !== session) return;
    // A session already being torn down, or already torn down, is never disposed a second time
    // for a later reason; the reason-coded diagnostic below reports why this call was made.
    if (session.recordingPin && isRunnerProcessAlive(session.child.pid))
      throw runnerSessionPinned(session);
    if (!canWorkWithRunnerSession(session)) return;
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_session_invalidated',
      data: {
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        reason,
      },
    });
    await stopRunnerSessionInternal(session.deviceId, session, {
      graceful: false,
      waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
    });
  });
}

export async function stopRunnerSessionInternal(
  deviceId: string,
  sessionOverride?: RunnerSession,
  options: RunnerDisposalOptions = {},
): Promise<void> {
  const session = sessionOverride ?? runnerSessions.get(deviceId);
  if (!session) return;
  // Once disposal has begun or finished, this session has no runner to wait on; a repeat stop
  // would only re-signal a process that is already leaving and re-emit a teardown for a reason
  // that has nothing left to tear down.
  if (session.recordingPin && isRunnerProcessAlive(session.child.pid))
    throw runnerSessionPinned(session);
  if (!canWorkWithRunnerSession(session)) return;
  await disposeRunnerSession(session, options);
  discardSimulatorRunnerContainerCache(session.deviceId, session.sessionId);
  if (runnerSessions.get(deviceId) === session) {
    runnerSessions.delete(deviceId);
  }
}

// Bounds the lifetime of a runner retained after session close: the retained
// runner holds the device's runner lease, which blocks every other daemon on
// the machine from using the device. If nothing touches the runner within the
// idle window, stop it and release the lease. Any ensureRunnerSession call
// cancels the pending stop. AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS overrides
// the window; 0 disables idle stops (retain until daemon exit, the pre-idle
// behavior).
export function scheduleIosRunnerIdleStop(deviceId: string): void {
  cancelIosRunnerIdleStop(deviceId);
  const idleMs = resolveRunnerIdleStopMs();
  if (idleMs <= 0) return;
  if (!runnerSessions.has(deviceId) || runnerSessions.get(deviceId)?.recordingPin) return;
  const timer = setTimeout(() => {
    runnerIdleStopTimers.delete(deviceId);
    emitDiagnostic({
      level: 'info',
      phase: 'ios_runner_idle_stop',
      data: { deviceId, idleMs },
    });
    stopIosRunnerSession(deviceId).catch((error: unknown) => {
      emitDiagnostic({
        level: 'warn',
        phase: 'ios_runner_idle_stop_failed',
        data: {
          deviceId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
  }, idleMs);
  timer.unref?.();
  runnerIdleStopTimers.set(deviceId, timer);
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_idle_stop_scheduled',
    data: { deviceId, idleMs },
  });
}

export function cancelIosRunnerIdleStop(deviceId: string): void {
  const timer = runnerIdleStopTimers.get(deviceId);
  if (!timer) return;
  clearTimeout(timer);
  runnerIdleStopTimers.delete(deviceId);
}

function resolveRunnerIdleStopMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return RUNNER_RETAINED_IDLE_STOP_DEFAULT_MS;
}

/** The first command that is not a readiness probe makes the session the caller's, not a guess. */
export function markRunnerSessionServed(session: RunnerSession, command: RunnerCommand): void {
  if (session.speculative && !isRunnerReadinessProbeCommand(command)) {
    session.speculative = false;
  }
}

/**
 * Stops the runner a prewarm started when no command has used it yet, so a proven
 * observation-only plan retains nothing it did not ask for. A runner that served a command is
 * the session's working runner and stays under the idle-stop policy.
 */
export async function releaseSpeculativeIosRunnerSession(deviceId: string): Promise<boolean> {
  // Under the session lock: a prewarm still starting holds it and registers its session only
  // when the start completes, so the release queues behind that start instead of missing it.
  return await withRunnerSessionLock(deviceId, async () => {
    const session = runnerSessions.get(deviceId);
    if (!session?.speculative) return false;
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_speculative_released',
      data: {
        deviceId,
        sessionId: session.sessionId,
        ready: session.state === 'ready',
      },
    });
    await stopIosRunnerSession(deviceId);
    return true;
  });
}

export async function stopIosRunnerSession(deviceId: string): Promise<void> {
  cancelIosRunnerIdleStop(deviceId);
  await withRunnerSessionLock(deviceId, async () => {
    await withRunnerLeaseLock(deviceId, async () => {
      await stopRunnerSessionInternal(deviceId, undefined, { leaseLockHeld: true });
      await cleanupOwnedIosRunnerLease(deviceId);
    });
  });
}

/**
 * Releases a runner at session close, preferring warm reuse only when the runner is actually
 * reusable. A non-retained close, or a retained close over a runner whose last exchange reported
 * main-thread work still draining, stops it now: a busy runner refuses every command until it drains
 * or wedges, so pooling it back hands the same stalled process to the next `open` (#2552). An idle
 * retained runner keeps warm reuse via the idle-stop timer. The decision is owned here because the
 * occupancy fact lives on the session, and awaited so `close` returns only once the lease is gone.
 */
export async function releaseIosRunnerOnClose(
  deviceId: string,
  options: { retain: boolean },
): Promise<void> {
  const session = runnerSessions.get(deviceId);
  if (options.retain && !isRunnerMainThreadOccupied(session)) {
    scheduleIosRunnerIdleStop(deviceId);
    return;
  }
  if (options.retain) {
    emitDiagnostic({
      level: 'info',
      phase: 'ios_runner_retain_skipped_busy',
      data: { deviceId },
    });
  }
  await stopIosRunnerSession(deviceId);
}

export async function abortAllIosRunnerSessions(): Promise<void> {
  const activeSessions = Array.from(runnerSessions.values()).filter(
    (session) => !session.recordingPin,
  );
  await abortRunnerSessionsAndPrepProcesses(activeSessions);
  for (const session of activeSessions) {
    if (runnerSessions.get(session.deviceId) === session) {
      runnerSessions.delete(session.deviceId);
    }
  }
}

type RunnerDetachSkippedReason =
  | RunnerHandoffRefusal
  | RunnerDetachRefusal
  | 'lease_absent'
  | 'runner_process_dead'
  | 'lease_write_failed';

// Graceful daemon shutdown hands a request-proven runner off to the next daemon instead of paying
// the xcodebuild ramp again: the lease token is rewritten to a detached form (so this daemon's own
// teardown paths no longer classify it as owned), this process gives up its sides of the runner's
// log, and the session simply leaves the in-memory map. Once this process exits the lease is stale
// and the adoption path picks it up. Explicit cleanup still works: clean:daemon kills by the lease's
// runnerPid, and the runner's XCTWaiter self-expires after 24h.
//
// Every gate that keeps a session on the kill path is named and reported, because a handoff that
// silently declines is indistinguishable from a rebuild: the handoff lanes
// (`resolveRunnerHandoffTarget`), a session that never served a command, still owes a response, or
// last reported main-thread work still draining (`resolveRunnerDetachDecision`), a missing or
// unwritable lease, and a runner this process cannot prove alive. What stays in the map is torn down by `stopAllIosRunnerSessions`, which the daemon's
// shutdown runs right after this — so a shutdown during a startup tears that runner down rather than
// handing off one that never reached its listener (#2681).
export async function detachIosRunnerSessionsForShutdown(): Promise<number> {
  if (!isIosRunnerDetachEnabled()) return 0;
  let detached = 0;
  for (const [deviceId, session] of runnerSessions) {
    if (session.recordingPin) continue;
    const outcome = detachRunnerSessionForShutdown(deviceId, session);
    if (!outcome.detached) {
      emitDiagnostic({
        level: 'debug',
        phase: 'ios_runner_session_detach_skipped',
        data: {
          deviceId,
          sessionId: session.sessionId,
          lane: outcome.lane,
          reason: outcome.reason,
          // A refused handoff is read from the daemon log, and the two refusals that name a charge look
          // identical without this: an exchange still awaited is recovered by its own answer, while an
          // abandoned residue waits for terminal evidence for its `commandId` (#2965).
          outstandingCharges: session.commandCharges.outstandingChargeCount,
          hasAbandonedCharges: session.commandCharges.hasAbandonedCharges,
        },
      });
      continue;
    }
    detached += 1;
    emitDiagnostic({
      level: 'info',
      phase: 'ios_runner_session_detached',
      data: {
        deviceId,
        lane: outcome.lane,
        sessionId: session.sessionId,
        runnerPid: session.child.pid,
        port: session.port,
        runnerLogPath: session.runnerLogPath,
      },
    });
  }
  return detached;
}

type RunnerDetachOutcome =
  | { detached: true; lane: RunnerHandoffLane }
  | { detached: false; lane: RunnerHandoffLane | undefined; reason: RunnerDetachSkippedReason };

function detachRunnerSessionForShutdown(
  deviceId: string,
  session: RunnerSession,
): RunnerDetachOutcome {
  const target = resolveRunnerHandoffTarget(session.device);
  if (!target.handoff) {
    return { detached: false, lane: undefined, reason: target.reason };
  }
  const lane = target.lane;
  const decision = resolveRunnerDetachDecision(session);
  if (!decision.detach) {
    return { detached: false, lane, reason: decision.reason };
  }
  const lease = session.lease;
  if (!lease) {
    return { detached: false, lane, reason: 'lease_absent' };
  }
  if (!isRunnerProcessAlive(session.child.pid)) {
    return { detached: false, lane, reason: 'runner_process_dead' };
  }
  try {
    writeRunnerLease(buildDetachedRunnerLease(lease));
  } catch {
    return { detached: false, lane, reason: 'lease_write_failed' };
  }
  // Only once the lease says the runner is handed over does this process give up its own sides of
  // the runner's log: until that write lands the session is still owned, and an owned session that
  // stopped following its runner's output is worse off than one that never handed anything off.
  // The runner holds its own descriptor, so this cannot disturb it either way (#2681).
  session.endOutputObservation?.();
  runnerSessions.delete(deviceId);
  cancelIosRunnerIdleStop(deviceId);
  advanceRunnerSessionState(session, 'stopped');
  return { detached: true, lane };
}

export async function stopAllIosRunnerSessions(): Promise<void> {
  await abortAllIosRunnerSessions();
  const pending = Array.from(runnerSessions.keys());
  await Promise.allSettled(
    pending.map(async (deviceId) => {
      await stopIosRunnerSession(deviceId);
    }),
  );
  await stopRunnerPrepProcesses();
}

export function validateRunnerDevice(device: DeviceInfo): void {
  if (!isApplePlatform(device.platform)) {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      `Unsupported platform for iOS runner: ${device.platform}`,
    );
  }
  if (device.kind !== 'simulator' && device.kind !== 'device') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `Unsupported iOS device kind for runner: ${device.kind}`,
    );
  }
}

/** Run an exchange against the owned session and complete fatal invalidation before returning. */
export async function executeRunnerCommandWithSession(
  device: DeviceInfo,
  session: RunnerSession,
  command: RunnerCommand,
  logPath: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  emitRunnerStartupTimings(session, command.command);
  const { executeRunnerExchange } = await import('./runner-exchange.ts');
  return executeRunnerExchange(
    device,
    session,
    command,
    logPath,
    timeoutMs,
    (reason) => invalidateRunnerSession(session, reason),
    signal,
  );
}

/**
 * What the xctestrun build may spend: the rest of the start budget, which an explicit
 * `buildTimeoutMs` can only shorten. The build is the one step with no ceiling of its own, so a
 * start with no caller left is still ended by the clock it opened (#2894). Throws when the start
 * has nothing left, so a spent budget fails before xcodebuild is spawned.
 */

/**
 * What the launched runner has to answer its first command, measured from launch. An explicit
 * `startupTimeoutMs` bounds the whole start, readiness included, so readiness gets what is left of
 * it. A defaulted start keeps the runner's own readiness window ({@link RUNNER_STARTUP_TIMEOUT_MS}):
 * the default budget is sized for a cold build, and a runner that never answers must not be joined
 * for the rest of it. Neither exceeds what the start budget has left.
 */

export async function measureRunnerStartupStep<T>(
  timings: Record<string, number>,
  phase: string,
  task: () => Promise<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await task();
  } finally {
    const durationMs = Date.now() - startedAt;
    timings[phase] = durationMs;
    emitDiagnostic({
      level: 'debug',
      phase: `ios_runner_startup_${phase}`,
      durationMs,
    });
  }
}

function emitRunnerStartupTimings(session: RunnerSession, command: string): void {
  if (session.startupTimingsReported || !session.startupTimings) return;
  session.startupTimingsReported = true;
  const totalMs = Object.values(session.startupTimings).reduce((sum, value) => sum + value, 0);
  emitDiagnostic({
    level: 'info',
    phase: 'ios_runner_session_startup_timings',
    durationMs: totalMs,
    data: {
      command,
      sessionId: session.sessionId,
      ready: session.state === 'ready',
      logicalLeaseContext: session.logicalLeaseContext,
      timings: session.startupTimings,
    },
  });
}
