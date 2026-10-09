import { expect, test, vi } from 'vitest';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import type { DaemonRequest } from '../../daemon-request.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  handleAppContainerJsonReadCommand,
  handleAppContainerJsonWriteCommand,
} from '../session-app-container-files.ts';
import { mockInspectDeviceRuntimeFacts } from './session-command-harness.ts';

const DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'simulator-1',
  name: 'iPhone',
  kind: 'device',
  target: 'mobile',
  booted: true,
  iosPhysicalDeviceBackend: 'coredevice',
};

function request(input: unknown): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command: 'app_container_write_json',
    positionals: [],
    flags: {},
    input: input as Record<string, unknown>,
  };
}

test('JSON read refuses semantic traversal before device selection or runtime binding', async () => {
  const resolveDevice = vi.fn(async () => DEVICE);
  const bindDevice = vi.fn() as unknown as BindDeviceRuntime;
  const req = {
    ...request({ app: 'ru.yandex.mobile.search', containerPath: '../config.json' }),
    command: 'app_container_read_json',
  };
  expect(await handleAppContainerJsonReadCommand({ req, resolveDevice, bindDevice })).toMatchObject(
    {
      ok: false,
      error: { code: 'INVALID_ARGS' },
    },
  );
  expect(resolveDevice).not.toHaveBeenCalled();
  expect(bindDevice).not.toHaveBeenCalled();
});

test('JSON read admits one request-scoped operation and preserves its receipt', async () => {
  const receipt = {
    appId: 'ru.yandex.mobile.search',
    containerPath: 'Documents/config.json',
    sha256: 'a'.repeat(64),
    byteLength: 17,
    value: { enabled: true },
  };
  const read = vi.fn(async () => receipt);
  const bindDevice = vi.fn(async () => ({
    operations: { readAppContainerJson: read },
  })) as unknown as BindDeviceRuntime;
  const req = {
    ...request({ app: receipt.appId, containerPath: receipt.containerPath }),
    command: 'app_container_read_json',
  };
  const inspectFacts: InspectDeviceRuntimeFacts = async (device) => {
    const facts = await mockInspectDeviceRuntimeFacts(device);
    return {
      ...facts,
      operations: { ...facts.operations, readAppContainerJson: { available: true } },
    };
  };
  const result = await handleAppContainerJsonReadCommand({
    req,
    resolveDevice: async () => DEVICE,
    inspectFacts,
    bindDevice,
  });
  expect(result).toEqual({ ok: true, data: receipt });
  expect(bindDevice).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith({ app: receipt.appId, containerPath: receipt.containerPath });
});

test.each([
  {
    app: 'ru.yandex.mobile.search',
    containerPath: '../Library/config.json',
    value: { enabled: true },
  },
  {
    app: 'ru.yandex.mobile.search',
    containerPath: 'Documents/local_config.json',
    value: { enabled: true },
    unexpected: true,
  },
])('rejects invalid semantic input before device facts or binding', async (input) => {
  const inspectFacts = vi.fn() satisfies InspectDeviceRuntimeFacts;
  const bindDevice = vi.fn() as unknown as BindDeviceRuntime;

  const response = await handleAppContainerJsonWriteCommand({
    req: request(input),
    resolveDevice: async () => DEVICE,
    inspectFacts,
    bindDevice,
  });

  expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  expect(inspectFacts).not.toHaveBeenCalled();
  expect(bindDevice).not.toHaveBeenCalled();
});

test('refuses unavailable runtime facts before binding or writing', async () => {
  const inspectFacts = vi.fn(async (device) => {
    const facts = await mockInspectDeviceRuntimeFacts(device);
    return {
      ...facts,
      operations: {
        ...facts.operations,
        writeAppContainerJson: {
          available: false as const,
          reason: 'owner-capability-missing' as const,
        },
      },
    };
  }) satisfies InspectDeviceRuntimeFacts;
  const bindDevice = vi.fn() as unknown as BindDeviceRuntime;

  const response = await handleAppContainerJsonWriteCommand({
    req: request({
      app: 'ru.yandex.mobile.search',
      containerPath: 'Documents/local_config.json',
      value: { enabled: true },
    }),
    resolveDevice: async () => DEVICE,
    inspectFacts,
    bindDevice,
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      details: { reason: 'owner-capability-missing' },
    },
  });
  expect(inspectFacts).toHaveBeenCalledOnce();
  expect(bindDevice).not.toHaveBeenCalled();
});
