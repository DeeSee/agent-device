import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.ts';

const { mockIsProcessAlive, mockReadProcessStartTime } = vi.hoisted(() => ({
  mockIsProcessAlive: vi.fn(() => false),
  mockReadProcessStartTime: vi.fn(() => null as string | null),
}));

import {
  buildRunnerLease,
  prepareRunnerLeaseForStartup,
  writeRunnerLease,
  type RunnerLeaseCleanupAdapter,
} from '../runner-lease.ts';

const launchIdentity = Object.freeze({
  selectorFingerprint: 'prepared-selector',
  testHostContainerBundleId: 'com.example.runner.xctrunner',
});

beforeEach(() => {
  appleRunnerTestHost.update({
    isProcessAlive: mockIsProcessAlive,
    readProcessStartTime: mockReadProcessStartTime,
  });
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync(
    'agent-device-environment-ownership-',
  );
  mockIsProcessAlive.mockReturnValue(false);
});

test('stale prepared lease never deletes its executed frozen plist', async () => {
  const cleanupTempFile = vi.fn<(filePath: string) => void>();
  writeStaleLease('prepared-device', {
    xctestrunPath: '/private/run/Products/AgentDeviceRunner.prepared.v1.xctestrun',
    ownedEnvironmentFiles: [],
  });

  await prepareRunnerLeaseForStartup(
    { ...IOS_SIMULATOR, id: 'prepared-device' },
    cleanupAdapter(cleanupTempFile),
  );

  expect(cleanupTempFile).not.toHaveBeenCalled();
});

test('stale generated-overlay lease deletes exactly its declared owned files', async () => {
  const cleanupTempFile = vi.fn<(filePath: string) => void>();
  writeStaleLease('legacy-device', {
    xctestrunPath: '/private/env/AgentDeviceRunner.env.xctestrun',
    ownedEnvironmentFiles: [
      '/private/env/AgentDeviceRunner.env.xctestrun',
      '/private/env/AgentDeviceRunner.env.json',
    ],
  });

  await prepareRunnerLeaseForStartup(
    { ...IOS_SIMULATOR, id: 'legacy-device' },
    cleanupAdapter(cleanupTempFile),
  );

  expect(cleanupTempFile.mock.calls).toEqual([
    ['/private/env/AgentDeviceRunner.env.xctestrun'],
    ['/private/env/AgentDeviceRunner.env.json'],
  ]);
});

test('invalid schema-2 lease without owned cleanup authority fails closed', async () => {
  const deviceId = 'invalid-decoded-device';
  const xctestrunPath = '/private/env/invalid.xctestrun';
  const lease = {
    ...buildRunnerLease({
      device: { ...IOS_SIMULATOR, id: deviceId },
      sessionId: `${deviceId}:8123:test`,
      runnerPid: 424242,
      port: 8123,
      xctestrunPath,
      ownedEnvironmentFiles: [xctestrunPath],
      launchIdentity,
      artifactSource: 'external',
    }),
    ownerToken: 'dead-owner',
    ownerPid: 999_999_991,
    ownerStartTime: 'dead-process-start',
  };
  const persisted = { ...lease } as Partial<typeof lease>;
  delete persisted.ownedEnvironmentFiles;
  fs.writeFileSync(
    path.join(process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR!, `${deviceId}.json`),
    JSON.stringify(persisted),
  );
  const cleanupTempFile = vi.fn<(filePath: string) => void>();

  await expect(
    prepareRunnerLeaseForStartup(
      { ...IOS_SIMULATOR, id: deviceId },
      cleanupAdapter(cleanupTempFile),
    ),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'runner_lease_invalid', deviceId },
  });

  expect(cleanupTempFile).not.toHaveBeenCalled();
});

test('malformed lease content fails closed before cleanup', async () => {
  const deviceId = 'malformed-lease-device';
  fs.writeFileSync(leasePath(deviceId), '{"schemaVersion":2');
  const cleanup = trackedCleanupAdapter();

  await expect(
    prepareRunnerLeaseForStartup({ ...IOS_SIMULATOR, id: deviceId }, cleanup.adapter),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'runner_lease_invalid', deviceId },
  });

  expect(cleanup.effects()).toEqual([]);
});

test.each([
  ['missing', undefined],
  ['mismatched', 'another-device'],
])('schema-2 lease with %s device identity fails closed before cleanup', async (_, persistedId) => {
  const deviceId = `invalid-identity-${persistedId ?? 'missing'}`;
  const persisted: Record<string, unknown> = {
    ...buildRunnerLease({
      device: { ...IOS_SIMULATOR, id: deviceId },
      sessionId: `${deviceId}:8123:test`,
      runnerPid: 424242,
      port: 8123,
      xctestrunPath: '/private/env/invalid.xctestrun',
      ownedEnvironmentFiles: [],
      launchIdentity,
      artifactSource: 'external',
    }),
  };
  if (persistedId === undefined) delete persisted.deviceId;
  else persisted.deviceId = persistedId;
  fs.writeFileSync(leasePath(deviceId), JSON.stringify(persisted));
  const cleanup = trackedCleanupAdapter();

  await expect(
    prepareRunnerLeaseForStartup({ ...IOS_SIMULATOR, id: deviceId }, cleanup.adapter),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'runner_lease_invalid', deviceId },
  });

  expect(cleanup.effects()).toEqual([]);
});

test('lease read failure fails closed before cleanup', async () => {
  const deviceId = 'unreadable-lease-device';
  const targetPath = leasePath(deviceId);
  fs.writeFileSync(targetPath, '{}');
  const realReadFileSync = fs.readFileSync.bind(fs);
  const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((filePath, ...args) => {
    if (filePath === targetPath) {
      throw Object.assign(new Error('read denied'), { code: 'EACCES' });
    }
    return realReadFileSync(filePath, ...args);
  }) as typeof fs.readFileSync);
  const cleanup = trackedCleanupAdapter();

  try {
    await expect(
      prepareRunnerLeaseForStartup({ ...IOS_SIMULATOR, id: deviceId }, cleanup.adapter),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'runner_lease_invalid', deviceId },
    });
  } finally {
    readSpy.mockRestore();
  }

  expect(cleanup.effects()).toEqual([]);
});

function writeStaleLease(
  deviceId: string,
  environment: {
    xctestrunPath: string;
    ownedEnvironmentFiles: readonly string[];
  },
): void {
  writeRunnerLease({
    ...buildRunnerLease({
      device: { ...IOS_SIMULATOR, id: deviceId },
      sessionId: `${deviceId}:8123:test`,
      runnerPid: 424242,
      port: 8123,
      xctestrunPath: environment.xctestrunPath,
      ownedEnvironmentFiles: environment.ownedEnvironmentFiles,
      launchIdentity,
      artifactSource: 'external',
    }),
    ownerToken: 'dead-owner',
    ownerPid: 999_999_991,
    ownerStartTime: 'dead-process-start',
  });
}

function cleanupAdapter(cleanupTempFile: (filePath: string) => void): RunnerLeaseCleanupAdapter {
  return {
    cleanupRunnerProcessTree: async () => {},
    cleanupRunnerXcodebuildProcesses: async () => {},
    cleanupTempFile,
  };
}

function leasePath(deviceId: string): string {
  return path.join(process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR!, `${deviceId}.json`);
}

function trackedCleanupAdapter(): {
  adapter: RunnerLeaseCleanupAdapter;
  effects: () => unknown[];
} {
  const cleanupRunnerProcessTree = vi.fn();
  const cleanupRunnerXcodebuildProcesses = vi.fn();
  const cleanupTempFile = vi.fn();
  return {
    adapter: {
      cleanupRunnerProcessTree,
      cleanupRunnerXcodebuildProcesses,
      cleanupTempFile,
    },
    effects: () => [
      ...cleanupRunnerProcessTree.mock.calls,
      ...cleanupRunnerXcodebuildProcesses.mock.calls,
      ...cleanupTempFile.mock.calls,
    ],
  };
}
