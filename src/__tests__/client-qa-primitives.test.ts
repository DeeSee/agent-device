import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '@agent-device/kernel/contracts';
import {
  createAgentDeviceClient,
  type AgentDeviceClientConfig,
  type SessionReserveOptions,
} from '../agent-device-client.ts';

function createTransport(
  handler: (request: Omit<DaemonRequest, 'token'>) => DaemonResponse | Promise<DaemonResponse>,
): {
  calls: Array<Omit<DaemonRequest, 'token'>>;
  config: AgentDeviceClientConfig;
  transport: (request: Omit<DaemonRequest, 'token'>) => Promise<DaemonResponse>;
} {
  const calls: Array<Omit<DaemonRequest, 'token'>> = [];
  return {
    calls,
    config: {
      session: 'qa',
      stateDir: '/tmp/agent-device-client-qa-primitives',
      daemonBaseUrl: 'http://daemon.example.test',
      daemonAuthToken: 'secret',
      daemonTransport: 'http',
    },
    transport: async (request) => {
      calls.push(request);
      return await handler(request);
    },
  };
}

function compileTimeSessionReserveOptionsProof(): void {
  const byDevice = { device: 'iPhone' } satisfies SessionReserveOptions;
  const byUdid = { udid: 'physical-1' } satisfies SessionReserveOptions;
  const bySerial = { serial: 'emulator-5554' } satisfies SessionReserveOptions;
  // @ts-expect-error A platform alone cannot identify the device to reserve.
  const missingSelector: SessionReserveOptions = { platform: 'ios' };
  // @ts-expect-error Reservation cannot silently prefer one conflicting selector.
  const conflictingSelectors: SessionReserveOptions = { udid: 'physical-1', device: 'iPhone' };
  void [byDevice, byUdid, bySerial, missingSelector, conflictingSelectors];
}
void compileTimeSessionReserveOptionsProof;

test('sessions.reserve sends an exact selector and normalizes structural ownership proof', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      session: 'qa-case',
      status: 'created',
      platform: 'ios',
      target: 'mobile',
      device: 'iPhone',
      id: 'physical-1',
      kind: 'device',
      device_udid: 'physical-1',
      ios_simulator_device_set: null,
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.sessions.reserve({
    session: 'qa-case',
    platform: 'ios',
    target: 'mobile',
    udid: 'physical-1',
  });

  assert.equal(setup.calls[0]?.command, 'session_reserve');
  assert.equal(setup.calls[0]?.session, 'qa-case');
  assert.equal(setup.calls[0]?.flags?.udid, 'physical-1');
  assert.deepEqual(result, {
    session: 'qa-case',
    status: 'created',
    device: {
      platform: 'ios',
      target: 'mobile',
      id: 'physical-1',
      name: 'iPhone',
      identifiers: {
        deviceId: 'physical-1',
        deviceName: 'iPhone',
        udid: 'physical-1',
      },
      ios: { udid: 'physical-1', simulatorSetPath: null },
    },
    identifiers: {
      session: 'qa-case',
      deviceId: 'physical-1',
      deviceName: 'iPhone',
      udid: 'physical-1',
    },
  });
});

test('sessions.reserve rejects an unknown daemon status', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      session: 'qa-case',
      status: 'opened',
      platform: 'ios',
      target: 'mobile',
      device: 'iPhone',
      id: 'physical-1',
      kind: 'device',
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await assert.rejects(
    client.sessions.reserve({ session: 'qa-case', platform: 'ios', udid: 'physical-1' }),
    /invalid reservation status/,
  );
});

test('apps.files.writeJson sends bounded semantic input and normalizes verification', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      appId: 'ru.yandex.mobile.search',
      containerPath: 'Documents/local_config.json',
      sha256: 'a'.repeat(64),
      byteLength: 20,
      verified: true,
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });
  const result = await client.apps.files.writeJson({
    platform: 'ios',
    udid: 'physical-1',
    app: 'ru.yandex.mobile.search',
    containerPath: 'Documents/local_config.json',
    value: { enabled: true },
  });

  assert.equal(setup.calls[0]?.command, 'app_container_write_json');
  assert.deepEqual(setup.calls[0]?.input, {
    app: 'ru.yandex.mobile.search',
    containerPath: 'Documents/local_config.json',
    value: { enabled: true },
  });
  assert.equal(setup.calls[0]?.flags?.platform, 'ios');
  assert.equal(setup.calls[0]?.flags?.udid, 'physical-1');
  assert.deepEqual(result, {
    appId: 'ru.yandex.mobile.search',
    containerPath: 'Documents/local_config.json',
    sha256: 'a'.repeat(64),
    byteLength: 20,
    verified: true,
  });
});

test.each([undefined, false])(
  'apps.files.writeJson rejects a daemon receipt with verified=%s',
  async (verified) => {
    const setup = createTransport(async () => ({
      ok: true,
      data: {
        appId: 'ru.yandex.mobile.search',
        containerPath: 'Documents/local_config.json',
        sha256: 'a'.repeat(64),
        byteLength: 20,
        ...(verified === undefined ? {} : { verified }),
      },
    }));
    const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

    await assert.rejects(
      client.apps.files.writeJson({
        platform: 'ios',
        udid: 'physical-1',
        app: 'ru.yandex.mobile.search',
        containerPath: 'Documents/local_config.json',
        value: { enabled: true },
      }),
      /invalid JSON write receipt/,
    );
  },
);
