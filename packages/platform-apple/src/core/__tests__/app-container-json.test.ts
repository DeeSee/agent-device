import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  type AppleAppContainerJsonDependencies,
  writeTextAtomicUnderRoot,
  writeVerifiedAppleAppContainerJson,
  readAppleAppContainerJson,
} from '../app-container-json.ts';

const VALUE = '{"enabled":true}\n';

function appleDevice(kind: 'simulator' | 'device'): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: kind === 'device' ? 'physical-1' : 'simulator-1',
    name: 'iPhone',
    kind,
    target: 'mobile',
    booted: true,
    ...(kind === 'device' ? { iosPhysicalDeviceBackend: 'xctest' as const } : {}),
  };
}

function dependencies(runXcrun: AppleAppContainerJsonDependencies['runXcrun']) {
  const files = new Map<string, string>();
  let temporaryIndex = 0;
  const value: AppleAppContainerJsonDependencies = {
    runXcrun,
    withTemporaryText: async (contents, operation) => {
      const pathname = `/private/tmp/app-config-${temporaryIndex++}.json`;
      files.set(pathname, contents);
      return await operation(pathname);
    },
    writeTextAtomicUnderRoot: async (containerRoot, containerPath, contents, signal) => {
      signal.throwIfAborted();
      const pathname = path.join(containerRoot, containerPath);
      files.set(pathname, contents);
      return pathname;
    },
    readText: async (pathname) => files.get(pathname) ?? '',
  };
  return { value, files };
}

test('physical JSON read copies only from the exact app container and hashes its original bytes', async () => {
  const fixture = dependencies(
    vi.fn(async (args) => {
      const destination = args[args.indexOf('--destination') + 1]!;
      fixture.files.set(destination, VALUE);
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
  );
  const result = await readAppleAppContainerJson(
    appleDevice('device'),
    {
      appId: 'ru.yandex.mobile.search',
      containerPath: 'Documents/local_config.json',
    },
    new AbortController().signal,
    fixture.value,
  );
  expect(result).toEqual({
    sha256: createHash('sha256').update(VALUE).digest('hex'),
    byteLength: Buffer.byteLength(VALUE),
    value: { enabled: true },
  });
  expect(fixture.value.runXcrun).toHaveBeenCalledTimes(1);
  expect((fixture.value.runXcrun as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual([
    'devicectl',
    'device',
    'copy',
    'from',
    '--device',
    'physical-1',
    '--source',
    'Documents/local_config.json',
    '--destination',
    '/private/tmp/app-config-0.json',
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    'ru.yandex.mobile.search',
  ]);
});

test('simulator JSON read rejects symlink escape without reading the target', async () => {
  const root = await mkdtempForTest('agent-device-json-read-');
  const outside = await mkdtempForTest('agent-device-json-outside-');
  await fs.writeFile(path.join(outside, 'config.json'), VALUE);
  await fs.symlink(outside, path.join(root, 'Documents'));
  const fixture = dependencies(vi.fn(async () => ({ stdout: root, stderr: '', exitCode: 0 })));
  const readText = vi.fn(async () => VALUE);
  await expect(
    readAppleAppContainerJson(
      appleDevice('simulator'),
      {
        appId: 'ru.yandex.mobile.search',
        containerPath: 'Documents/config.json',
      },
      new AbortController().signal,
      { ...fixture.value, readText },
    ),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  expect(readText).not.toHaveBeenCalled();
});

test('JSON reads refuse nonobject and oversized app files', async () => {
  let contents = '[]';
  const fixture = dependencies(
    vi.fn(async (args) => {
      fixture.files.set(args[args.indexOf('--destination') + 1]!, contents);
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
  );
  const read = () =>
    readAppleAppContainerJson(
      appleDevice('device'),
      {
        appId: 'ru.yandex.mobile.search',
        containerPath: 'Documents/config.json',
      },
      new AbortController().signal,
      fixture.value,
    );
  await expect(read()).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  contents = JSON.stringify({ value: 'x'.repeat(256 * 1024) });
  await expect(read()).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'app_container_json_too_large' },
  });
});

test('physical write publishes and verifies through exact devicectl appDataContainer copies', async () => {
  let remote = '';
  const fixture = dependencies(
    vi.fn(async (args) => {
      const direction = args[3];
      const source = args[args.indexOf('--source') + 1]!;
      const destination = args[args.indexOf('--destination') + 1]!;
      if (direction === 'to') remote = fixture.files.get(source) ?? '';
      if (direction === 'from') fixture.files.set(destination, remote);
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
  );

  const result = await writeVerifiedAppleAppContainerJson(
    appleDevice('device'),
    {
      appId: 'ru.yandex.mobile.search',
      containerPath: 'Documents/local_config.json',
      serializedValue: VALUE,
    },
    new AbortController().signal,
    fixture.value,
  );

  expect(result).toEqual({
    sha256: createHash('sha256').update(VALUE).digest('hex'),
    byteLength: Buffer.byteLength(VALUE),
  });
  const calls = (fixture.value.runXcrun as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[0]).toEqual([
    'devicectl',
    'device',
    'copy',
    'to',
    '--device',
    'physical-1',
    '--source',
    '/private/tmp/app-config-0.json',
    '--destination',
    'Documents/local_config.json',
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    'ru.yandex.mobile.search',
  ]);
  expect(calls[1]?.[0]?.[3]).toBe('from');
});

test('simulator write resolves the data container and verifies the exact bytes', async () => {
  const runXcrun = vi.fn(async () => ({
    stdout: '/private/sim/data\n',
    stderr: '',
    exitCode: 0,
  }));
  const fixture = dependencies(runXcrun);

  await expect(
    writeVerifiedAppleAppContainerJson(
      appleDevice('simulator'),
      {
        appId: 'ru.yandex.mobile.search',
        containerPath: 'Documents/local_config.json',
        serializedValue: VALUE,
      },
      new AbortController().signal,
      fixture.value,
    ),
  ).resolves.toMatchObject({ byteLength: Buffer.byteLength(VALUE) });

  expect(runXcrun).toHaveBeenCalledWith(
    ['simctl', 'get_app_container', 'simulator-1', 'ru.yandex.mobile.search', 'data'],
    expect.objectContaining({ allowFailure: true }),
  );
  expect(fixture.files.get('/private/sim/data/Documents/local_config.json')).toBe(VALUE);
});

test('invalid paths and pre-cancelled requests perform no Apple tool call', async () => {
  const runXcrun = vi.fn();
  const fixture = dependencies(runXcrun);
  const input = {
    appId: 'ru.yandex.mobile.search',
    containerPath: '../Library/secret.json',
    serializedValue: VALUE,
  };
  await expect(
    writeVerifiedAppleAppContainerJson(
      appleDevice('device'),
      input,
      new AbortController().signal,
      fixture.value,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });

  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(
    writeVerifiedAppleAppContainerJson(
      appleDevice('device'),
      { ...input, containerPath: 'Documents/local_config.json' },
      controller.signal,
      fixture.value,
    ),
  ).rejects.toThrow('cancelled');
  expect(runXcrun).not.toHaveBeenCalled();
});

test('read-back mismatch fails instead of publishing a receipt', async () => {
  const fixture = dependencies(
    vi.fn(async (args) => {
      if (args[3] === 'from') {
        const destination = args[args.indexOf('--destination') + 1]!;
        fixture.files.set(destination, '{"enabled":false}\n');
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
  );
  await expect(
    writeVerifiedAppleAppContainerJson(
      appleDevice('device'),
      {
        appId: 'ru.yandex.mobile.search',
        containerPath: 'Documents/local_config.json',
        serializedValue: VALUE,
      },
      new AbortController().signal,
      fixture.value,
    ),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
});

test('simulator writer refuses a symlinked parent without touching its target', async () => {
  const containerRoot = await mkdtempForTest('agent-device-container-');
  const outsideRoot = await mkdtempForTest('agent-device-outside-');
  try {
    await fs.mkdir(path.join(containerRoot, 'Documents'));
    await fs.symlink(outsideRoot, path.join(containerRoot, 'Documents', 'link'));
    const runXcrun = vi.fn(async () => ({
      stdout: `${containerRoot}\n`,
      stderr: '',
      exitCode: 0,
    }));
    const dependencies: AppleAppContainerJsonDependencies = {
      runXcrun,
      withTemporaryText: async (_contents, operation) => await operation('/unused'),
      writeTextAtomicUnderRoot,
      readText: async (pathname) => await fs.readFile(pathname, 'utf8'),
    };

    await expect(
      writeVerifiedAppleAppContainerJson(
        appleDevice('simulator'),
        {
          appId: 'ru.yandex.mobile.search',
          containerPath: 'Documents/link/config.json',
          serializedValue: VALUE,
        },
        new AbortController().signal,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    await expect(fs.stat(path.join(outsideRoot, 'config.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await fs.rm(containerRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});

test('simulator cancellation before publish leaves the destination unchanged', async () => {
  const controller = new AbortController();
  const files = new Map<string, string>([
    ['/private/sim/data/Documents/local_config.json', '{"old":true}\n'],
  ]);
  const dependencies: AppleAppContainerJsonDependencies = {
    runXcrun: vi.fn(async () => ({
      stdout: '/private/sim/data\n',
      stderr: '',
      exitCode: 0,
    })),
    withTemporaryText: async (_contents, operation) => await operation('/unused'),
    writeTextAtomicUnderRoot: async (containerRoot, containerPath, contents, signal) => {
      const pathname = path.join(containerRoot, containerPath);
      const temporaryPath = `${pathname}.tmp`;
      files.set(temporaryPath, contents);
      controller.abort(new Error('cancelled before publish'));
      signal.throwIfAborted();
      files.set(pathname, files.get(temporaryPath) ?? '');
      return pathname;
    },
    readText: async (pathname) => files.get(pathname) ?? '',
  };

  await expect(
    writeVerifiedAppleAppContainerJson(
      appleDevice('simulator'),
      {
        appId: 'ru.yandex.mobile.search',
        containerPath: 'Documents/local_config.json',
        serializedValue: VALUE,
      },
      controller.signal,
      dependencies,
    ),
  ).rejects.toThrow('cancelled before publish');
  expect(files.get('/private/sim/data/Documents/local_config.json')).toBe('{"old":true}\n');
});
