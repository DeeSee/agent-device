// Copyright 2026 Yandex LLC. All rights reserved.

import { beforeEach, expect, test, vi } from 'vitest';
import { IOS_SIMULATOR, IOS_DEVICE } from '../../runner/__tests__/device-fixtures.ts';
import { observeIosAppProcesses } from '../app-processes.ts';
import { runXcrun, runAppleToolCommand } from '../tool-provider.ts';
import { readHostTextFile } from '@agent-device/host-kit/host-file';

vi.mock('../tool-provider.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tool-provider.ts')>()),
  runXcrun: vi.fn(),
  runAppleToolCommand: vi.fn(),
}));
vi.mock('../plist.ts', () => ({ readInfoPlistString: vi.fn(async () => 'Demo') }));
vi.mock('@agent-device/host-kit/host-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/host-file')>()),
  readHostTextFile: vi.fn(),
  unlinkHostFile: vi.fn(async () => {}),
}));
const tool = vi.mocked(runXcrun);
const read = vi.mocked(readHostTextFile);
const hostTool = vi.mocked(runAppleToolCommand);
const bundlePath = '/private/var/apps/selected/Demo.app';

beforeEach(() => {
  vi.clearAllMocks();
  tool.mockReset();
  hostTool.mockReset();
  read.mockReset();
});

test('simulator query matches its exact installed executable, scopes the simulator set, and deduplicates pids', async () => {
  const signal = new AbortController().signal;
  const device = { ...IOS_SIMULATOR, simulatorSetPath: '/private/isolated-set' };
  tool.mockResolvedValueOnce({ exitCode: 0, stdout: bundlePath, stderr: '' });
  tool.mockResolvedValueOnce({
    exitCode: 0,
    stderr: '',
    stdout: [
      '22 0.0 1 /private/var/apps/selected/Demo.app/Demo --arg',
      '3 0.0 1 /var/apps/selected/Demo.app/Demo',
      '22 0.0 1 /private/var/apps/selected/Demo.app/Demo',
      '80 0.0 1 /private/var/apps/another/Demo.app/Demo',
      '81 0.0 1 /private/var/apps/selected/Demo.app/DemoOther',
    ].join('\n'),
  });
  expect(await observeIosAppProcesses(device, 'com.example.app', signal)).toEqual({
    processIds: [3, 22],
  });
  expect(tool.mock.calls[1]?.[0]).toEqual([
    'simctl',
    '--set',
    '/private/isolated-set',
    'spawn',
    device.id,
    'ps',
    '-axo',
    'pid=,%cpu=,rss=,command=',
  ]);
  expect(tool.mock.calls.every(([, options]) => options?.signal === signal)).toBe(true);
});

test('a simulator without ps observes only its exact executable in the host process table', async () => {
  const signal = new AbortController().signal;
  tool.mockResolvedValueOnce({ exitCode: 0, stdout: bundlePath, stderr: '' });
  tool.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'ps unavailable' });
  hostTool.mockResolvedValueOnce({
    exitCode: 0,
    stderr: '',
    stdout: [
      '52 0.0 1 /var/apps/selected/Demo.app/Demo',
      '53 0.0 1 /private/var/apps/another/Demo.app/Demo',
    ].join('\n'),
  });
  expect(await observeIosAppProcesses(IOS_SIMULATOR, 'com.example.app', signal)).toEqual({
    processIds: [52],
  });
  expect(hostTool).toHaveBeenCalledWith(
    'ps',
    ['-axo', 'pid=,%cpu=,rss=,command='],
    expect.objectContaining({ signal }),
  );
});

test('cancellation during simulator process observation does not start a host query', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel simulator ps');
  tool.mockResolvedValueOnce({ exitCode: 0, stdout: bundlePath, stderr: '' });
  tool.mockImplementationOnce(async () => {
    controller.abort(reason);
    return { exitCode: 1, stdout: '', stderr: 'ps unavailable' };
  });
  await expect(
    observeIosAppProcesses(IOS_SIMULATOR, 'com.example.app', controller.signal),
  ).rejects.toBe(reason);
  expect(hostTool).not.toHaveBeenCalled();
});

test('CoreDevice query includes only processes underneath the exact installed app URL', async () => {
  const signal = new AbortController().signal;
  tool.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  read.mockResolvedValueOnce(
    JSON.stringify({
      result: {
        apps: [
          {
            bundleIdentifier: 'com.example.app',
            name: 'Demo',
            url: 'file:///private/app/Demo.app/',
          },
        ],
      },
    }),
  );
  read.mockResolvedValueOnce(
    JSON.stringify({
      result: {
        runningProcesses: [
          { processIdentifier: 22, executable: 'file:///private/app/Demo.app/Demo' },
          { processIdentifier: 3, executable: 'file:///private/app/Demo.app/PlugIns/ext' },
          { processIdentifier: 22, executable: 'file:///private/app/Demo.app/Demo' },
          { processIdentifier: 70, executable: 'file:///private/app/Demo.app-other/Demo' },
        ],
      },
    }),
  );
  expect(await observeIosAppProcesses(IOS_DEVICE, 'com.example.app', signal)).toEqual({
    processIds: [3, 22],
  });
  expect(tool.mock.calls.every(([, options]) => options?.signal === signal)).toBe(true);
});

test('a stopped installed app answers an empty process set', async () => {
  tool.mockResolvedValueOnce({ exitCode: 0, stdout: bundlePath, stderr: '' });
  tool.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
  expect(
    await observeIosAppProcesses(IOS_SIMULATOR, 'com.example.app', new AbortController().signal),
  ).toEqual({ processIds: [] });
  expect(hostTool).not.toHaveBeenCalled();
});

test('cancellation before observation performs no native calls', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel process query');
  controller.abort(reason);
  await expect(
    observeIosAppProcesses(IOS_SIMULATOR, 'com.example.app', controller.signal),
  ).rejects.toBe(reason);
  expect(tool).not.toHaveBeenCalled();
});
