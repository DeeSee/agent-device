import { appleRunnerTestHost } from '../test-host.ts';
import { beforeEach, vi, type Mock } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  makeBackgroundRunner,
  makeRunnerLease,
  makeClassifyOwnerLivenessViaMocks,
} from './runner-session-fixtures.ts';

export const mocks: Record<
  | 'acquireRedirect'
  | 'cleanupTempFile'
  | 'ensureArtifact'
  | 'freePort'
  | 'isProcessAlive'
  | 'isProcessGroupAlive'
  | 'prepareEnv'
  | 'readProcessCommand'
  | 'readProcessStartTime'
  | 'resolveDerived'
  | 'resolveSelection'
  | 'runAppleTool'
  | 'runBackground'
  | 'runXcrun'
  | 'signalPids'
  | 'signalProcessGroup'
  | 'waitForRunner'
  | 'releaseRedirect',
  Mock
> = vi.hoisted(() => ({
  acquireRedirect: vi.fn(),
  cleanupTempFile: vi.fn(),
  ensureArtifact: vi.fn(),
  freePort: vi.fn(),
  isProcessAlive: vi.fn(),
  isProcessGroupAlive: vi.fn(),
  prepareEnv: vi.fn(),
  readProcessCommand: vi.fn(),
  readProcessStartTime: vi.fn((_pid?: number) => 'fixed-test-owner-start-time' as string | null),
  resolveDerived: vi.fn(),
  resolveSelection: vi.fn(),
  runAppleTool: vi.fn(),
  runBackground: vi.fn(),
  runXcrun: vi.fn(),
  signalPids: vi.fn(),
  signalProcessGroup: vi.fn(),
  waitForRunner: vi.fn(),
  releaseRedirect: vi.fn(),
}));

vi.mock('../runner-io.ts', async () => ({
  ...(await vi.importActual<typeof import('../runner-io.ts')>('../runner-io.ts')),
  cleanupTempFile: mocks.cleanupTempFile,
  getFreePort: mocks.freePort,
}));

vi.mock('../runner-startup-transport.ts', async () => ({
  ...(await vi.importActual<typeof import('../runner-startup-transport.ts')>(
    '../runner-startup-transport.ts',
  )),
  waitForRunner: mocks.waitForRunner,
}));

vi.mock('../runner-xctestrun.ts', async () => ({
  ...(await vi.importActual<typeof import('../runner-xctestrun.ts')>('../runner-xctestrun.ts')),
  acquireXcodebuildSimulatorSetRedirect: mocks.acquireRedirect,
  ensureXctestrunArtifact: mocks.ensureArtifact,
  prepareXctestrunWithEnv: mocks.prepareEnv,
  resolveRunnerLaunchSelection: mocks.resolveSelection,
}));

import { abortAllIosRunnerSessions } from '../runner-session.ts';
import { runnerOwnerToken } from '../runner-lease.ts';

beforeEach(async () => {
  appleRunnerTestHost.update({
    runCmdBackground: mocks.runBackground,
    isProcessAlive: mocks.isProcessAlive,
    isProcessGroupAlive: mocks.isProcessGroupAlive,
    readProcessCommand: mocks.readProcessCommand,
    readProcessStartTime: mocks.readProcessStartTime,
    signalPidsBestEffort: mocks.signalPids,
    signalProcessGroupBestEffort: mocks.signalProcessGroup,
    runAppleToolCommand: mocks.runAppleTool,
    runXcrun: mocks.runXcrun,
    leaseOwnerStateDir: () => undefined,
    classifyOwnerLiveness: makeClassifyOwnerLivenessViaMocks({
      isProcessAlive: (pid) => Boolean(mocks.isProcessAlive(pid)),
      readProcessStartTime: (pid) => mocks.readProcessStartTime(pid),
    }),
  });
  const { runnerSessions } = await import('../runner-session-registry.ts');
  for (const session of runnerSessions.values()) {
    session.recordingPin = undefined;
    if (session.lease) session.lease.recordingPin = undefined;
  }
  await abortAllIosRunnerSessions();
  vi.resetAllMocks();

  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync(
    'agent-device-runner-authority-test-',
  );
  mocks.runXcrun.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mocks.ensureArtifact.mockImplementation(async (_device, options) => ({
    xctestrunPath: '/tmp/base-runner.xctestrun',
    derived: options.runnerLaunchSelection.derived,
    cache: 'miss',
    artifact: 'rebuilt',
    buildMs: 12,
    xctestrunPathSource: 'build',
    launchIdentity: options.runnerLaunchSelection.identity,
  }));
  mocks.freePort.mockResolvedValue(8123);
  mocks.prepareEnv.mockResolvedValue({
    xctestrunPath: '/tmp/session-runner.xctestrun',
    jsonPath: '/tmp/session-runner.json',
  });
  mocks.resolveDerived.mockReturnValue('/tmp/derived');
  mocks.resolveSelection.mockImplementation(async (_device, options = {}) => {
    const external = options.iosXctestrunFile;
    const derived = external ? `${external}.derived` : mocks.resolveDerived();
    return {
      source: external ? 'external' : 'internal',
      identity: {
        selectorFingerprint: external ?? `internal:${derived}`,
        testHostContainerBundleId: 'com.example.runner.xctrunner',
      },
      derived,
      ...(external ? { xctestrunPath: external } : {}),
    };
  });
  mocks.acquireRedirect.mockResolvedValue({ release: mocks.releaseRedirect });
  mocks.runBackground.mockReturnValue(makeBackgroundRunner(4242));
  mocks.runAppleTool.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mocks.isProcessAlive.mockImplementation(
    (pid: number | undefined) => pid === process.pid || pid === 4242,
  );
  mocks.isProcessGroupAlive.mockReturnValue(false);
  mocks.readProcessCommand.mockReturnValue(null);
  mocks.readProcessStartTime.mockImplementation((pid?: number) =>
    pid === process.pid ? 'fixed-test-owner-start-time' : null,
  );
});

export function pinnedLease(
  deviceId: string,
  overrides: Readonly<{ ownerPid?: number; ownerToken?: string }> = {},
) {
  const lease = makeRunnerLease({ deviceId, ...overrides });
  const ownedLease = overrides.ownerToken
    ? lease
    : {
        ...lease,
        ownerPid: process.pid,
        ownerStartTime: 'fixed-test-owner-start-time',
        ownerToken: runnerOwnerToken(),
      };
  return {
    ...ownedLease,
    recordingPin: {
      authority: {
        runnerSessionId: lease.sessionId,
        launchIdentity: lease.launchIdentity,
        startCommandId: `record-start-${deviceId}`,
        remotePath: `tmp/${deviceId}.mp4`,
      },
      state: 'nonfinalized' as const,
    },
  };
}

export function hasReason(reason: string) {
  return (error: unknown) => error instanceof AppError && error.details?.reason === reason;
}
