import type { Mock } from 'vitest';
import {
  stubRunnerDeviceReadiness,
  makeClassifyOwnerLivenessViaMocks,
  captureDiagnostics,
  makeBackgroundRunner,
  makeRunnerLease,
  makeRunnerSession,
  runnerResponse,
  RUNNER_CACHE_METADATA_FIXTURE,
  RUNNER_CACHE_KEY_FIXTURE,
} from './runner-session-fixtures.ts';
import { RUNNER_LAUNCH_IDENTITY_FIXTURE } from './runner-identity-fixtures.ts';

import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';

import { mkdtempForTestSync } from './tmp-dir.ts';
import { abortAllIosRunnerSessions, executeRunnerCommandWithSession } from '../runner-session.ts';
import {
  writeRunnerLease,
  type RunnerLease,
  type RunnerLeaseCleanupAdapter,
  type RunnerXcodebuildCleanupTarget,
} from '../runner-lease.ts';
const {
  mockCleanupTempFile,
  mockEnsureXctestrunArtifact,
  mockGetFreePort,
  mockIsProcessAlive,
  mockIsProcessGroupAlive,
  mockPrepareXctestrunWithEnv,
  mockReadProcessCommand,
  mockReadProcessStartTime,
  mockResolveExpectedRunnerCacheMetadata,
  mockResolveRunnerDerivedPath,
  mockRunAppleToolCommand,
  mockRunCmdBackground,
  mockRunXcrun,
  mockSendRunnerCommandOnce,
  mockSignalPidsBestEffort,
  mockSignalProcessGroupBestEffort,
  mockWaitForRunner,
}: {
  mockCleanupTempFile: Mock;
  mockEnsureXctestrunArtifact: Mock;
  mockGetFreePort: Mock;
  mockIsProcessAlive: Mock;
  mockIsProcessGroupAlive: Mock;
  mockPrepareXctestrunWithEnv: Mock;
  mockReadProcessCommand: Mock;
  mockReadProcessStartTime: Mock;
  mockResolveExpectedRunnerCacheMetadata: Mock;
  mockResolveRunnerDerivedPath: Mock;
  mockRunAppleToolCommand: Mock;
  mockRunCmdBackground: Mock;
  mockRunXcrun: Mock;
  mockSendRunnerCommandOnce: Mock;
  mockSignalPidsBestEffort: Mock;
  mockSignalProcessGroupBestEffort: Mock;
  mockWaitForRunner: Mock;
} = vi.hoisted(() => ({
  mockCleanupTempFile: vi.fn(),
  mockEnsureXctestrunArtifact: vi.fn(),
  mockGetFreePort: vi.fn(),
  mockIsProcessAlive: vi.fn(),
  mockIsProcessGroupAlive: vi.fn(),
  mockPrepareXctestrunWithEnv: vi.fn(),
  // Non-empty default: TEST_OWNER_START_TIME below feeds both this mock and
  // runnerOwnerStartTime()'s first (memoized) call - see the beforeEach
  // wiring and R8 in the conversion guide. readProcessStartTime's real
  // implementation shells out to `ps` with a 1s timeout that can miss under
  // CPU contention, flipping a live owner to 'owner-process-dead'.
  // Deterministic value, no shell-out; identity is still enforced by pid in
  // beforeEach below.
  mockReadProcessCommand: vi.fn((_pid: number) => null as string | null),
  mockReadProcessStartTime: vi.fn((_pid: number) => 'fixed-test-owner-start-time' as string | null),
  mockResolveExpectedRunnerCacheMetadata: vi.fn(),
  mockResolveRunnerDerivedPath: vi.fn(),
  mockRunAppleToolCommand: vi.fn(),
  mockRunCmdBackground: vi.fn(),
  mockRunXcrun: vi.fn(),
  mockSendRunnerCommandOnce: vi.fn(),
  // The runner child pid below is fabricated (4242), so the signal writes are
  // mocked next to the liveness reads: a real signal to a made-up pid can hit a
  // sibling vitest fork (#1824), and the shared setup refuses it outright.
  mockSignalPidsBestEffort: vi.fn(),
  mockSignalProcessGroupBestEffort: vi.fn(),
  mockWaitForRunner: vi.fn(),
}));

const TEST_OWNER_START_TIME = 'fixed-test-owner-start-time';

vi.mock('../runner-io.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-io.ts')>('../runner-io.ts');
  return {
    ...actual,
    cleanupTempFile: mockCleanupTempFile,
    getFreePort: mockGetFreePort,
  };
});

vi.mock('../runner-startup-transport.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-startup-transport.ts')>(
    '../runner-startup-transport.ts',
  );
  return {
    ...actual,
    waitForRunner: mockWaitForRunner,
  };
});

vi.mock('../runner-transport.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-transport.ts')>('../runner-transport.ts');
  return {
    ...actual,
    sendRunnerCommandOnce: mockSendRunnerCommandOnce,
  };
});

vi.mock('../runner-xctestrun.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-xctestrun.ts')>('../runner-xctestrun.ts');
  return {
    ...actual,
    ensureXctestrunArtifact: mockEnsureXctestrunArtifact,
    prepareXctestrunWithEnv: mockPrepareXctestrunWithEnv,
    resolveExpectedRunnerCacheMetadata: mockResolveExpectedRunnerCacheMetadata,
    resolveRunnerLaunchSelection: async (
      device: unknown,
      options: Record<string, unknown>,
      budget: unknown,
    ) => {
      const cache = mockResolveExpectedRunnerCacheMetadata(device, undefined, budget);
      const derived = mockResolveRunnerDerivedPath(device, cache);
      return {
        source: options.iosXctestrunFile ? 'external' : 'internal',
        identity: {
          selectorFingerprint: JSON.stringify([
            derived,
            cache,
            options.iosXctestrunFile,
            options.iosXctestEnvDir,
          ]),
          testHostContainerBundleId: 'com.callstack.agentdevice.runner.uitests.xctrunner',
        },
        derived,
        expectedCacheMetadata: cache,
      };
    },
    resolveRunnerDerivedPath: mockResolveRunnerDerivedPath,
  };
});

let leaseOwnerStateDirOverride: string | undefined;

function setRunnerLeaseOwnerStateDir(stateDir: string | undefined): void {
  leaseOwnerStateDirOverride = stateDir;
}

beforeEach(async () => {
  stubRunnerDeviceReadiness();
  // Must run before abortAllIosRunnerSessions() below: that call can tear
  // down sessions left in memory by the PREVIOUS test, and its cleanup path
  // signals real processes (host.signalPidsBestEffort et al.) unless the
  // host overrides are already installed. The setup file's own beforeEach
  // (which runs before this one) just wiped them back to real defaults.
  appleRunnerTestHost.update({
    runCmdBackground: mockRunCmdBackground,
    isProcessAlive: mockIsProcessAlive,
    isProcessGroupAlive: mockIsProcessGroupAlive,
    readProcessCommand: mockReadProcessCommand,
    readProcessStartTime: mockReadProcessStartTime,
    signalPidsBestEffort: mockSignalPidsBestEffort,
    signalProcessGroupBestEffort: mockSignalProcessGroupBestEffort,
    runAppleToolCommand: mockRunAppleToolCommand,
    runXcrun: mockRunXcrun,
    leaseOwnerStateDir: () => leaseOwnerStateDirOverride,
    classifyOwnerLiveness: makeClassifyOwnerLivenessViaMocks({
      isProcessAlive: (pid) => Boolean(mockIsProcessAlive(pid)),
      readProcessStartTime: (pid) => (mockReadProcessStartTime(pid) as string | null) ?? null,
    }),
  });
  await abortAllIosRunnerSessions();
  vi.resetAllMocks();
  setRunnerLeaseOwnerStateDir(undefined);
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync(
    'agent-device-runner-lease-test-',
  );
  mockRunXcrun.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockEnsureXctestrunArtifact.mockResolvedValue({
    launchIdentity: RUNNER_LAUNCH_IDENTITY_FIXTURE,

    xctestrunPath: '/tmp/base-runner.xctestrun',
    derived: '/tmp/derived',
    cacheKey: RUNNER_CACHE_KEY_FIXTURE,
    cache: 'miss',
    artifact: 'rebuilt',
    buildMs: 12,
    xctestrunPathSource: 'build',
  });
  mockGetFreePort.mockResolvedValue(8123);
  mockPrepareXctestrunWithEnv.mockResolvedValue({
    xctestrunPath: '/tmp/session-runner.xctestrun',
    jsonPath: '/tmp/session-runner.json',
  });
  mockResolveExpectedRunnerCacheMetadata.mockReturnValue(RUNNER_CACHE_METADATA_FIXTURE);
  mockResolveRunnerDerivedPath.mockReturnValue('/tmp/derived');
  mockRunCmdBackground.mockReturnValue(makeBackgroundRunner(4242));
  mockRunAppleToolCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockIsProcessAlive.mockReturnValue(true);
  mockIsProcessGroupAlive.mockReturnValue(false);
  mockReadProcessCommand.mockReturnValue(null);
  // Our pid reads back its fixed start time; any other pid reads as
  // not-found, same as a real `ps` miss. Dead-lease tests use fabricated
  // pids already rejected by mockIsProcessAlive before this is consulted.
  mockReadProcessStartTime.mockImplementation((pid: number) =>
    pid === process.pid ? TEST_OWNER_START_TIME : null,
  );
  mockWaitForRunner.mockResolvedValue(runnerResponse({ uptimeMs: 1 }));
});

function makeRecordingCleanupAdapter() {
  const treeKills: Array<{ pid: number | undefined; signal: string }> = [];
  const xcodebuildCleanups: RunnerXcodebuildCleanupTarget[] = [];
  const adapter: RunnerLeaseCleanupAdapter = {
    async cleanupRunnerProcessTree(pid, signal) {
      treeKills.push({ pid, signal });
    },
    async cleanupRunnerXcodebuildProcesses(target) {
      xcodebuildCleanups.push(target);
    },
    cleanupTempFile() {},
  };
  return { adapter, treeKills, xcodebuildCleanups };
}

function writeStaleLeaseWithRunner(
  deviceId: string,
  runner: Pick<RunnerLease, 'runnerPid' | 'runnerStartTime'>,
): void {
  mockIsProcessAlive.mockImplementation((pid) => pid !== 999_999_999);
  writeRunnerLease(
    makeRunnerLease({
      deviceId,
      ownerToken: 'owner-dead-recycled',
      ownerPid: 999_999_999,
      ...runner,
    }),
  );
}

function isXcodebuildPkillCall(call: unknown[]): boolean {
  const args = call[1];
  return call[0] === 'pkill' && Array.isArray(args) && args.includes('-f');
}

function isDevToolsSecurityStatusCall(call: unknown[]): boolean {
  const args = call[1];
  return call[0] === 'DevToolsSecurity' && Array.isArray(args) && args[0] === '-status';
}

function mockDevToolsSecurityDisabled(): void {
  mockRunAppleToolCommand.mockImplementation(async (cmd, args) => {
    if (cmd === 'DevToolsSecurity' && args[0] === '-status') {
      return {
        exitCode: 0,
        stdout: 'Developer mode is currently disabled.\n',
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

const ALLOWLISTED_MUTATIONS: { name: string; command: Record<string, unknown> }[] = [
  { name: 'tap', command: { command: 'tap', x: 120, y: 240 } },
  {
    name: 'selector tap',
    command: { command: 'tap', selectorKey: 'label', selectorValue: 'Open article' },
  },
  { name: 'longPress', command: { command: 'longPress', x: 1, y: 2 } },
  { name: 'drag', command: { command: 'drag', x: 1, y: 2, x2: 3, y2: 4 } },
  { name: 'swipe', command: { command: 'swipe', x: 1, y: 2, x2: 3, y2: 4 } },
  { name: 'scroll', command: { command: 'scroll', direction: 'down' } },
  { name: 'desktopScroll', command: { command: 'desktopScroll', direction: 'down' } },
  {
    name: 'sequence',
    command: { command: 'sequence', steps: [{ kind: 'tap', x: 120, y: 240 }] },
  },
];

for (const { name, command } of ALLOWLISTED_MUTATIONS) {
  test(`runner session skips readiness preflight for ${name} after a fresh same-bundle healthy mutation`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T00:00:00Z'));
    try {
      const session = makeRunnerSession({
        state: 'ready',
        lastHealthyMutation: { atMs: Date.now() - 1_500, appBundleId: 'com.example.demo' },
      });
      mockSendRunnerCommandOnce.mockResolvedValueOnce(runnerResponse({ acted: true }));

      const diagnostics = await captureDiagnostics(async () => {
        await executeRunnerCommandWithSession(
          IOS_SIMULATOR,
          session,
          { ...command, appBundleId: 'com.example.demo' } as Parameters<
            typeof executeRunnerCommandWithSession
          >[2],
          '/tmp/runner.log',
          30_000,
        );
      });

      assert.equal(mockWaitForRunner.mock.calls.length, 0);
      assert.equal(mockSendRunnerCommandOnce.mock.calls.length, 1);
      assert.match(diagnostics, /ios_runner_readiness_preflight_skipped/);
      assert.match(diagnostics, /"reason":"recent_healthy_mutation"/);
      assert.match(diagnostics, /"lastHealthyMutationAgeMs":1500/);
    } finally {
      vi.useRealTimers();
    }
  });
}
export const testFixture = {
  mockCleanupTempFile,
  mockEnsureXctestrunArtifact,
  mockGetFreePort,
  mockIsProcessAlive,
  mockIsProcessGroupAlive,
  mockPrepareXctestrunWithEnv,
  mockReadProcessCommand,
  mockReadProcessStartTime,
  mockResolveExpectedRunnerCacheMetadata,
  mockResolveRunnerDerivedPath,
  mockRunAppleToolCommand,
  mockRunCmdBackground,
  mockRunXcrun,
  mockSendRunnerCommandOnce,
  mockSignalPidsBestEffort,
  mockSignalProcessGroupBestEffort,
  mockWaitForRunner,
  TEST_OWNER_START_TIME,
  leaseOwnerStateDirOverride,
  setRunnerLeaseOwnerStateDir,
  makeRecordingCleanupAdapter,
  writeStaleLeaseWithRunner,
  isXcodebuildPkillCall,
  isDevToolsSecurityStatusCall,
  mockDevToolsSecurityDisabled,
  ALLOWLISTED_MUTATIONS,
};
