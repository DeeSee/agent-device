import { expect, test, vi } from 'vitest';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import type { DaemonRequest } from '../../daemon-request.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { handleAppContainerJsonWriteCommand } from '../session-app-container-files.ts';
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
