import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

const mocks = vi.hoisted(() => ({
  isAgentDeviceDaemonProcess: vi.fn(),
  isProcessAlive: vi.fn(),
  sleep: vi.fn(async () => undefined),
  trySignalProcess: vi.fn(),
  waitForDaemonExit: vi.fn(),
}));

vi.mock('../daemon-process.ts', () => ({
  isAgentDeviceDaemonProcess: mocks.isAgentDeviceDaemonProcess,
  trySignalProcess: mocks.trySignalProcess,
  waitForDaemonExit: mocks.waitForDaemonExit,
}));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  isProcessAlive: mocks.isProcessAlive,
}));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: mocks.sleep,
}));

import { resolveDaemonPaths } from '../daemon-resolution.ts';
import { stopDaemon } from '../daemon-stop.ts';

afterEach(() => {
  vi.clearAllMocks();
});

function createDaemonPaths(): ReturnType<typeof resolveDaemonPaths> {
  const stateDir = mkdtempForTestSync('agent-device-daemon-stop-');
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(paths.infoPath, JSON.stringify({ pid: 123, processStartTime: 'start-time' }));
  return paths;
}

function removeDaemonPaths(paths: ReturnType<typeof resolveDaemonPaths>): void {
  fs.rmSync(paths.baseDir, { recursive: true, force: true });
}

test('reports not-running when daemon metadata is absent', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-daemon-stop-'));

  try {
    const result = await stopDaemon({ paths });
    expect(result).toMatchObject({ stopped: false, mode: 'not-running' });
  } finally {
    removeDaemonPaths(paths);
  }
});

test('refuses to signal a live process whose daemon identity cannot be verified', async () => {
  const paths = createDaemonPaths();
  mocks.isAgentDeviceDaemonProcess.mockReturnValue(false);
  mocks.isProcessAlive.mockReturnValue(true);

  try {
    await assert.rejects(
      async () => await stopDaemon({ paths }),
      (error: { code?: string }) => error.code === 'COMMAND_FAILED',
    );
    expect(mocks.trySignalProcess).not.toHaveBeenCalled();
  } finally {
    removeDaemonPaths(paths);
  }
});

test('refuses to signal a live process when daemon metadata lacks a non-empty start-time identity', async () => {
  const paths = createDaemonPaths();
  fs.writeFileSync(paths.infoPath, JSON.stringify({ pid: 123, processStartTime: ' ' }));
  mocks.isProcessAlive.mockReturnValue(true);

  try {
    await assert.rejects(
      async () => await stopDaemon({ paths }),
      (error: { code?: string }) => error.code === 'COMMAND_FAILED',
    );
    expect(mocks.isAgentDeviceDaemonProcess).not.toHaveBeenCalled();
    expect(mocks.trySignalProcess).not.toHaveBeenCalled();
  } finally {
    removeDaemonPaths(paths);
  }
});

test('treats an exited daemon between identity verification and SIGTERM as not-running', async () => {
  const paths = createDaemonPaths();
  mocks.isAgentDeviceDaemonProcess.mockReturnValue(true);
  mocks.trySignalProcess.mockReturnValue(false);
  mocks.isProcessAlive.mockReturnValue(false);

  try {
    const result = await stopDaemon({ paths });
    expect(result).toMatchObject({ stopped: false, mode: 'not-running' });
  } finally {
    removeDaemonPaths(paths);
  }
});

test('reports graceful cleanup after SIGTERM exits the verified daemon', async () => {
  const paths = createDaemonPaths();
  mocks.isAgentDeviceDaemonProcess.mockReturnValue(true);
  mocks.trySignalProcess.mockReturnValue(true);
  mocks.waitForDaemonExit.mockImplementation(async () => {
    fs.rmSync(paths.infoPath, { force: true });
    return { exited: true, elapsedMs: 0 };
  });

  try {
    const result = await stopDaemon({ paths });
    expect(result).toMatchObject({
      stopped: true,
      mode: 'graceful',
      cleanupConfidence: 'unknown',
      providerReleases: { pending: null },
    });
    expect(mocks.trySignalProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  } finally {
    removeDaemonPaths(paths);
  }
});

test('a slow daemon remains running and stop never escalates beyond SIGTERM', async () => {
  const paths = createDaemonPaths();
  mocks.isAgentDeviceDaemonProcess.mockReturnValue(true);
  mocks.trySignalProcess.mockReturnValue(true);
  mocks.waitForDaemonExit.mockResolvedValue({ exited: false, elapsedMs: 0 });

  try {
    const result = await stopDaemon({ paths });
    expect(result).toMatchObject({
      stopped: false,
      mode: 'grace-timeout',
      cleanupConfidence: 'unknown',
      providerReleases: { pending: null },
    });
    expect(mocks.trySignalProcess).toHaveBeenCalledTimes(1);
    expect(mocks.trySignalProcess).toHaveBeenCalledWith(123, 'SIGTERM');
  } finally {
    removeDaemonPaths(paths);
  }
});
