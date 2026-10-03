import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { createAgentDeviceClient } from '../agent-device-client.ts';

function createDeploymentClient(response: DaemonResponse): Readonly<{
  client: ReturnType<typeof createAgentDeviceClient>;
  calls: Array<Omit<DaemonRequest, 'token'>>;
}> {
  const calls: Array<Omit<DaemonRequest, 'token'>> = [];
  const transport = async (request: Omit<DaemonRequest, 'token'>): Promise<DaemonResponse> => {
    calls.push(request);
    return response;
  };
  return {
    client: createAgentDeviceClient({ session: 'qa', cwd: '/tmp/agent-device' }, { transport }),
    calls,
  };
}

test('apps.reinstall can derive app identity and normalizes the selected device identity', async () => {
  const setup = createDeploymentClient({
    ok: true,
    data: {
      app: 'com.example.derived',
      appPath: '/tmp/Derived.app',
      platform: 'ios',
      bundleId: 'com.example.derived',
      deviceId: 'DEVICE-001',
      deviceName: 'iPhone',
    },
  });

  const result = await setup.client.apps.reinstall({
    appPath: '/tmp/Derived.app',
    platform: 'ios',
  });

  assert.equal(setup.calls[0]?.command, 'reinstall');
  assert.deepEqual(setup.calls[0]?.positionals, ['/tmp/Derived.app']);
  assert.equal(result.identifiers.appId, 'com.example.derived');
  assert.equal(result.identifiers.deviceId, 'DEVICE-001');
  assert.equal(result.identifiers.udid, 'DEVICE-001');
  assert.equal(result.identifiers.deviceName, 'iPhone');
});

test('apps.reinstall rejects an incomplete selected device identity', async () => {
  const setup = createDeploymentClient({
    ok: true,
    data: {
      app: 'com.example.derived',
      appPath: '/tmp/Derived.app',
      platform: 'ios',
      bundleId: 'com.example.derived',
      deviceId: 'DEVICE-001',
    },
  });

  await assert.rejects(
    setup.client.apps.reinstall({ appPath: '/tmp/Derived.app', platform: 'ios' }),
    (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
  );
});

test('apps.reinstall preserves compatibility with a legacy response lacking device identity', async () => {
  const setup = createDeploymentClient({
    ok: true,
    data: {
      app: 'com.example.legacy',
      appPath: '/tmp/Legacy.app',
      platform: 'ios',
      bundleId: 'com.example.legacy',
    },
  });

  const result = await setup.client.apps.reinstall({
    appPath: '/tmp/Legacy.app',
    platform: 'ios',
  });

  assert.equal(result.identifiers.appId, 'com.example.legacy');
  assert.equal(result.identifiers.deviceId, undefined);
  assert.equal(result.identifiers.deviceName, undefined);
});

test('apps.reinstall rejects supplied malformed selected device identities', async () => {
  for (const malformedIdentity of [
    { deviceId: 42, deviceName: 43 },
    { deviceId: '', deviceName: '' },
  ]) {
    const setup = createDeploymentClient({
      ok: true,
      data: {
        app: 'com.example.derived',
        appPath: '/tmp/Derived.app',
        platform: 'ios',
        bundleId: 'com.example.derived',
        ...malformedIdentity,
      },
    });

    await assert.rejects(
      setup.client.apps.reinstall({ appPath: '/tmp/Derived.app', platform: 'ios' }),
      (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
    );
  }
});
