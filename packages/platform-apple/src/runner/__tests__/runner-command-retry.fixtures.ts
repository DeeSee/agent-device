import type { Mock } from 'vitest';
import { RUNNER_LAUNCH_IDENTITY_FIXTURE } from './runner-identity-fixtures.ts';
import { beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';

import {
  makeRunnerArtifact,
  createTestRequestCancellation,
  makeRunnerSession,
} from './runner-session-fixtures.ts';

import { appleRunnerTestHost } from '../test-host.ts';
import { prepareIosRunner } from '../runner-client.ts';
import { resetRunnerRecycleLedgerForTests } from '../runner-recycle-ledger.ts';

const {
  mockEnsureRunnerSession,
  mockExecuteRunnerCommandWithSession,
  mockEmitDiagnostic,
  mockReadRunnerSessionLiveness,
  mockInvalidateRunnerSession,
  mockMarkRunnerXctestrunArtifactBadForRun,
}: {
  mockEnsureRunnerSession: Mock;
  mockExecuteRunnerCommandWithSession: Mock;
  mockEmitDiagnostic: Mock;
  mockReadRunnerSessionLiveness: Mock;
  mockInvalidateRunnerSession: Mock;
  mockMarkRunnerXctestrunArtifactBadForRun: Mock;
} = vi.hoisted(() => ({
  mockEnsureRunnerSession: vi.fn(),
  mockExecuteRunnerCommandWithSession: vi.fn(),
  mockEmitDiagnostic: vi.fn(),
  mockReadRunnerSessionLiveness: vi.fn(),
  mockInvalidateRunnerSession: vi.fn(),
  mockMarkRunnerXctestrunArtifactBadForRun: vi.fn(),
}));

vi.mock('../runner-session.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-session.ts')>('../runner-session.ts');
  return {
    ...actual,
    ensureRunnerSession: mockEnsureRunnerSession,
    executeRunnerCommandWithSession: mockExecuteRunnerCommandWithSession,
    readRunnerSessionLiveness: mockReadRunnerSessionLiveness,
    invalidateRunnerSession: mockInvalidateRunnerSession,
  };
});

vi.mock('../runner-xctestrun.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-xctestrun.ts')>('../runner-xctestrun.ts');
  return {
    ...actual,
    markRunnerXctestrunArtifactBadForRun: mockMarkRunnerXctestrunArtifactBadForRun,
  };
});

const requestCancellation = createTestRequestCancellation();

const { markRequestCanceled, clearRequestCanceled, isRequestCanceled } = requestCancellation;

beforeEach(() => {
  vi.resetAllMocks();
  resetRunnerRecycleLedgerForTests();
  mockReadRunnerSessionLiveness.mockReturnValue(null);
  mockMarkRunnerXctestrunArtifactBadForRun.mockResolvedValue(undefined);
  requestCancellation.reset();
  appleRunnerTestHost.update({
    emitDiagnostic: mockEmitDiagnostic,
    isRequestCanceled,
    getRequestSignal: () => undefined,
  });
});

function makeBadCacheRecoveryFixtures() {
  const restoredArtifact = makeRunnerArtifact({
    xctestrunPath: '/tmp/restored.xctestrun',
    cache: 'exact',
    artifact: 'valid',
  });
  const rebuiltArtifact = makeRunnerArtifact({
    xctestrunPath: '/tmp/rebuilt.xctestrun',
    cache: 'miss',
    artifact: 'rebuilt',
    buildMs: 123,
  });
  const restoredSession = makeRunnerSession({
    port: 8100,
    xctestrunPath: restoredArtifact.xctestrunPath,
    xctestrunArtifact: restoredArtifact,
  });
  const rebuiltSession = makeRunnerSession({
    port: 8101,
    xctestrunPath: rebuiltArtifact.xctestrunPath,
    xctestrunArtifact: rebuiltArtifact,
  });

  return { restoredArtifact, restoredSession, rebuiltSession };
}

function assertRecoveredPrepareResult(result: Awaited<ReturnType<typeof prepareIosRunner>>): void {
  assert.deepEqual(result, {
    runnerSessionId: 'session-8101',
    launchIdentity: RUNNER_LAUNCH_IDENTITY_FIXTURE,
    runner: { uptimeMs: 42 },
    cache: 'miss',
    artifact: 'rebuilt',
    buildMs: 123,
    connectMs: result.connectMs,
    healthCheckMs: result.healthCheckMs,
    xctestrunPath: '/tmp/rebuilt.xctestrun',
    recoveryReason: 'Runner did not accept connection',
  });
  assert.equal(result.failureReason, undefined);
  assert.equal(result.connectMs >= 0, true);
  assert.equal(result.healthCheckMs >= 0, true);
}

function assertBadCacheRecoverySideEffects(
  fixtures: ReturnType<typeof makeBadCacheRecoveryFixtures>,
): void {
  assert.deepEqual(mockInvalidateRunnerSession.mock.calls[0], [
    fixtures.restoredSession,
    'prepare_cached_runner_health_failed',
  ]);
  assert.deepEqual(mockMarkRunnerXctestrunArtifactBadForRun.mock.calls[0], [
    fixtures.restoredArtifact,
    'Runner did not accept connection',
  ]);
  assert.deepEqual(mockEnsureRunnerSession.mock.calls[1]?.[1], {
    healthTimeoutMs: 90_000,
    buildTimeoutMs: 300_000,
    cleanStaleBundles: true,
    forceRunnerXctestrunRebuild: true,
  });
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[2].command, 'uptime');
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[0]?.[4], 90_000);
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls[1]?.[1], fixtures.rebuiltSession);
}

function assertRecoveredPrepareDiagnostics(): void {
  assert.ok(
    mockEmitDiagnostic.mock.calls.some(
      ([event]) => event.phase === 'ios_runner_prepare_bad_cache_recovered',
    ),
  );
  const prepareDiagnostic = mockEmitDiagnostic.mock.calls.find(
    ([event]) => event.phase === 'apple_runner_prepare',
  )?.[0];
  assert.ok(prepareDiagnostic);
  assert.equal(prepareDiagnostic.level, 'info');
  assert.equal(prepareDiagnostic.data?.cache, 'miss');
  assert.equal(prepareDiagnostic.data?.artifact, 'rebuilt');
  assert.equal(prepareDiagnostic.data?.xctestrunPath, '/tmp/rebuilt.xctestrun');
  assert.equal(prepareDiagnostic.data?.recoveryReason, 'Runner did not accept connection');
  assert.equal(prepareDiagnostic.data?.failureReason, undefined);
  assert.deepEqual(prepareDiagnostic.data?.timingContainment, {
    connectMs: ['buildMs'],
    healthCheckMs: [],
  });
}

function assertDiagnosticDecision(expected: {
  decision: 'skipped' | 'retained';
  reason: string;
  lifecycleState?: string;
}): void {
  assert.ok(
    mockEmitDiagnostic.mock.calls.some(([event]) => {
      return (
        event.phase === 'ios_runner_command_invalidation_decision' &&
        event.data?.decision === expected.decision &&
        event.data?.reason === expected.reason &&
        event.data?.lifecycleState === expected.lifecycleState
      );
    }),
    `missing invalidation decision diagnostic ${JSON.stringify(expected)}`,
  );
}

async function captureDiagnostics(callback: () => Promise<void>): Promise<string> {
  await callback();
  return JSON.stringify(mockEmitDiagnostic.mock.calls.map(([event]) => event));
}
export const testFixture = {
  mockEnsureRunnerSession,
  mockExecuteRunnerCommandWithSession,
  mockEmitDiagnostic,
  mockReadRunnerSessionLiveness,
  mockInvalidateRunnerSession,
  mockMarkRunnerXctestrunArtifactBadForRun,
  requestCancellation,
  markRequestCanceled,
  clearRequestCanceled,
  isRequestCanceled,
  makeBadCacheRecoveryFixtures,
  assertRecoveredPrepareResult,
  assertBadCacheRecoverySideEffects,
  assertRecoveredPrepareDiagnostics,
  assertDiagnosticDecision,
  captureDiagnostics,
};
