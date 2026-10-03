import { type RunnerLaunchSelection } from './runner-xctestrun.ts';

import { createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  Deadline,
  emitRequestProgress,
  emitDiagnostic,
  buildSimctlArgsForDevice,
  runXcrun,
} from './host.ts';
import type { ExecResult } from '@agent-device/host-kit/command';
import { type DeviceInfo } from '@agent-device/kernel/device';

import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';

import { flushRunnerLogAppends, getFreePort, resolveRunnerLaunchLogPath } from './runner-io.ts';
import { RUNNER_STARTUP_TIMEOUT_MS } from './runner-startup-transport.ts';
import {
  createRunnerPhaseBudget,
  ensureXctestrunArtifact,
  prepareXctestrunWithEnv,
  requireRunnerPhaseRemainingMs,
} from './runner-xctestrun.ts';

import { enrichRunnerStartupFailureWithDeviceStates } from './runner-error-classification.ts';

import {
  buildRunnerLease,
  prepareRunnerLeaseForStartup,
  runnerOwnerToken,
  writeRunnerLease,
} from './runner-lease.ts';
import { tryAdoptRunnerSessionFromLease } from './runner-adoption.ts';
import {
  disposeRunnerSession,
  runnerLeaseCleanupAdapter,
  RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
} from './runner-disposal.ts';
import {
  buildRunnerSessionId,
  normalizeRunnerStartupTimeoutMs,
  RunnerCommandAccounting,
  type RunnerSession,
} from './runner-session-types.ts';
import { launchRunnerProcess, type LaunchedRunnerProcess } from './runner-process-launch.ts';

import type { RunnerStartBudget } from './runner-start-budget.ts';
import { runnerSessions } from './runner-session-registry.ts';
import {
  assertRunnerSessionMayStart,
  measureRunnerStartupStep,
  stopRunnerSessionInternal,
  type RunnerSessionOptions,
} from './runner-session.ts';
const RUNNER_STALE_BUNDLE_UNINSTALL_TIMEOUT_MS = 10_000;

const RUNNER_DEVICE_READINESS_BUDGET_MS = 10_000;

export async function startRunnerSessionWithLease(
  device: DeviceInfo,
  options: RunnerSessionOptions,
  budget: RunnerStartBudget,
  requestedSelection: RunnerLaunchSelection,
  startConstraints: Readonly<{ excludedPort?: number }>,
): Promise<RunnerSession> {
  const startupTimings: Record<string, number> = {};
  const startupBudget = budget.phase;
  const signal = startupBudget.signal;
  const logicalLeaseContext = normalizeRunnerLogicalLeaseContext(
    options.runnerLeaseContext,
    device.id,
  );
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_session_startup',
    data: {
      deviceId: device.id,
      logicalLeaseContext,
    },
  });
  const adopted = await measureRunnerStartupStep(
    startupTimings,
    'adopt_detached_runner',
    async () =>
      await tryAdoptRunnerSessionFromLease(device, {
        budget: startupBudget,
        requestedSelection,
        expectedRunnerSessionId: options.expectedRunnerSessionId,
      }),
  );
  if (adopted) {
    adopted.startupTimings = startupTimings;
    adopted.logicalLeaseContext = logicalLeaseContext;
    runnerSessions.set(device.id, adopted);
    return adopted;
  }
  assertRunnerSessionMayStart(options.expectedRunnerSessionId);
  await measureRunnerStartupStep(startupTimings, 'cleanup_stale_xcodebuild', async () => {
    await prepareRunnerLeaseForStartup(device, runnerLeaseCleanupAdapter, logicalLeaseContext);
  });
  await measureRunnerStartupStep(startupTimings, 'ensure_booted', async () => {
    await ensureBootedIfNeeded(device);
  });
  // Device first, host second: both answers can be wrong at once, and the phone's own state is the
  // one the caller can act on without admin rights. Probing the host first would publish only the
  // Mac's reason and hide the device's (#2683).
  // Only a disabled Developer Mode toggle stops the run here; whatever else the device reports rides
  // along onto the build below, because iOS 17+ mounts the developer disk image on demand during
  // build and launch and refusing that state up front would refuse a state this build clears (#2683).
  const deviceStates = await measureRunnerStartupStep(
    startupTimings,
    'verify_device_readiness',
    async () =>
      await (
        await import('./runner-device-readiness.ts')
      ).preflightIosRunnerDeviceReadiness(device, {
        budgetMs: Math.min(
          RUNNER_DEVICE_READINESS_BUDGET_MS,
          startupBudget.deadline?.remainingMs() ?? RUNNER_DEVICE_READINESS_BUDGET_MS,
        ),
        signal,
      }),
  );
  await measureRunnerStartupStep(startupTimings, 'verify_host_dev_tools_security', async () => {
    // Loaded here for the same reason as the device probe above.
    const { assertDevToolsSecurityForIosRunner } = await import('./runner-dev-tools-security.ts');
    await assertDevToolsSecurityForIosRunner(device);
  });
  if (options.cleanStaleBundles) {
    await measureRunnerStartupStep(startupTimings, 'cleanup_stale_bundles', async () => {
      await cleanupStaleSimulatorRunnerBundles(
        device,
        requestedSelection.identity.testHostContainerBundleId,
      );
    });
  } else {
    startupTimings.cleanup_stale_bundles = 0;
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_startup_cleanup_stale_bundles_skipped',
    });
  }
  let xctestrunArtifact: Awaited<ReturnType<typeof ensureXctestrunArtifact>>;
  let port: number;
  let xctestrunPath: string;

  let ownedEnvironmentFiles: readonly string[];
  const runnerLogPath = resolveRunnerLaunchLogPath(options.logPath, device.id);
  let runnerProcess: LaunchedRunnerProcess;
  // One catch for everything between here and a runner that answers, because the device's own answer
  // belongs on all of it (#2690 review): a cold build, a warm derived cache that fails at install, and
  // an external xctestrun that never launches are different steps, and a caller told "developer disk
  // image" should not have to know which one this run happened to take.
  try {
    xctestrunArtifact = await measureRunnerStartupStep(
      startupTimings,
      'ensure_xctestrun',
      async () =>
        await ensureXctestrunArtifact(device, {
          ...options,
          runnerLaunchSelection: requestedSelection,
          budget: createRunnerPhaseBudget(resolveRunnerBuildTimeoutMs(options, budget), signal),
        }),
    );
    startupTimings.build_xctestrun = xctestrunArtifact.buildMs;
    const { prepareRunnerEnvironment } = await import('./runner-environment-plan.ts');
    const environment = await measureRunnerStartupStep(
      startupTimings,
      'prepare_xctestrun_env',
      async () =>
        await prepareRunnerEnvironment({
          baseXctestrunPath: xctestrunArtifact.xctestrunPath,
          deviceId: device.id,
          ownerToken: runnerOwnerToken(),
          iosXctestEnvDir: options.iosXctestEnvDir,
          excludedPort: startConstraints.excludedPort,
          allocatePort: async () =>
            await measureRunnerStartupStep(
              startupTimings,
              'allocate_port',
              async () => await getFreePort(),
            ),
          prepareOverlay: prepareXctestrunWithEnv,
        }),
    );
    ({ port, xctestrunPath, ownedEnvironmentFiles } = environment);

    if (xctestrunArtifact.buildMs > 0) {
      emitRequestProgress({
        type: 'command',
        status: 'progress',
        message: 'Starting XCTest runner...',
      });
    }
    runnerProcess = await measureRunnerStartupStep(
      startupTimings,
      'launch_xcodebuild',
      async () => {
        // Build output reaches this same file through an async append queue, so the offset that marks
        // where this generation's output starts is only trustworthy once those bytes have landed below
        // it; otherwise a queued build line reads as the runner's own failure output (#2681).
        await flushRunnerLogAppends(runnerLogPath).catch(() => {});
        return await launchRunnerProcess({
          device,
          port,
          xctestrunPath,
          derivedPath: xctestrunArtifact.derived,
          signal,
          logPath: runnerLogPath,
          traceLogPath: options.traceLogPath,
          verbose: options.verbose,
        });
      },
    );
  } catch (error) {
    throw enrichRunnerStartupFailureWithDeviceStates(error, deviceStates);
  }
  const sessionId = buildRunnerSessionId(device.id, port);
  const lease = buildRunnerLease({
    device,
    sessionId,
    runnerPid: runnerProcess.child.pid,
    artifactSource: requestedSelection.source,
    port,
    xctestrunPath,
    cacheKey: xctestrunArtifact.cacheKey,

    ownedEnvironmentFiles,
    launchIdentity: requestedSelection.identity,
    runnerLogPath,
  });
  const session: RunnerSession = {
    sessionId,
    device,
    deviceId: device.id,
    port,
    xctestrunPath,
    xctestrunArtifact,

    ownedEnvironmentFiles,
    launchIdentity: requestedSelection.identity,
    runnerLogPath,
    testPromise: runnerProcess.wait,
    child: runnerProcess.child,
    endOutputObservation: runnerProcess.endOutputObservation,
    readLogTail: runnerProcess.readLogTail,
    state: 'starting',
    commandCharges: new RunnerCommandAccounting(),
    startupRetryWake: runnerProcess.startupRetryWake,
    listenerReadiness: runnerProcess.listenerReadiness,
    launchDeadline: Deadline.fromTimeoutMs(resolveRunnerLaunchReadinessMs(budget)),
    startupTimings,
    startupDeviceStates: deviceStates,
    logicalLeaseContext,
    lease,
    speculative: options.speculative === true,
  };
  if (signal?.aborted) {
    await disposeRunnerSession(session, {
      graceful: false,
      waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
      leaseLockHeld: true,
    });
    throw createRequestCanceledError();
  }
  try {
    writeRunnerLease(lease);
  } catch (error) {
    await stopRunnerSessionInternal(device.id, session, {
      graceful: false,
      waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
      leaseLockHeld: true,
    });
    throw error;
  }
  runnerSessions.set(device.id, session);
  return session;
}

async function cleanupStaleSimulatorRunnerBundles(
  device: DeviceInfo,
  testHostContainerBundleId: string,
): Promise<void> {
  if (device.kind !== 'simulator') return;
  const result = await uninstallStaleSimulatorRunnerBundle(device, testHostContainerBundleId);
  if (!result || isBenignSimulatorRunnerUninstallResult(result)) return;
}

async function uninstallStaleSimulatorRunnerBundle(
  device: DeviceInfo,
  bundleId: string,
): Promise<ExecResult | undefined> {
  try {
    return await runXcrun(buildSimctlArgsForDevice(device, ['uninstall', device.id, bundleId]), {
      allowFailure: true,
      timeoutMs: RUNNER_STALE_BUNDLE_UNINSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_startup_cleanup_stale_bundle_failed',
      data: {
        deviceId: device.id,
        bundleId,
        timeoutMs: RUNNER_STALE_BUNDLE_UNINSTALL_TIMEOUT_MS,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}

function isBenignSimulatorRunnerUninstallResult(result: ExecResult): boolean {
  if (result.exitCode === 0) return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes('not installed') ||
    output.includes('found nothing') ||
    output.includes('no such file') ||
    output.includes('invalid device') ||
    output.includes('could not find')
  );
}

function resolveRunnerBuildTimeoutMs(
  options: RunnerSessionOptions,
  budget: RunnerStartBudget,
): number {
  const remainingMs =
    requireRunnerPhaseRemainingMs(budget.phase, 'runner_xctestrun_build') ?? budget.timeoutMs;
  const explicitMs = normalizeRunnerStartupTimeoutMs(options.buildTimeoutMs);
  return explicitMs === undefined ? remainingMs : Math.min(explicitMs, remainingMs);
}

function resolveRunnerLaunchReadinessMs(budget: RunnerStartBudget): number {
  const remainingMs = Math.floor(budget.phase.deadline?.remainingMs() ?? budget.timeoutMs);
  return budget.explicit ? remainingMs : Math.min(RUNNER_STARTUP_TIMEOUT_MS, remainingMs);
}

function normalizeRunnerLogicalLeaseContext(
  context: RunnerLogicalLeaseContext | undefined,
  deviceKey: string,
): RunnerLogicalLeaseContext | undefined {
  if (!context) return undefined;
  const normalized = {
    leaseId: readOptionalContextString(context.leaseId),
    clientId: readOptionalContextString(context.clientId),
    tenantId: readOptionalContextString(context.tenantId),
    runId: readOptionalContextString(context.runId),
    leaseProvider: readOptionalContextString(context.leaseProvider),
    deviceKey: readOptionalContextString(context.deviceKey) ?? deviceKey,
  };
  const entries = Object.entries(normalized).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readOptionalContextString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function ensureBootedIfNeeded(device: DeviceInfo): Promise<void> {
  if (device.kind !== 'simulator') {
    return Promise.resolve();
  }
  if (device.booted) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_startup_ensure_booted_skipped',
      data: { deviceId: device.id },
    });
    return Promise.resolve();
  }
  return ensureBooted(device);
}

async function ensureBooted(device: DeviceInfo): Promise<void> {
  await runXcrun(buildSimctlArgsForDevice(device, ['bootstatus', device.id, '-b']), {
    timeoutMs: RUNNER_STARTUP_TIMEOUT_MS,
  });
}
