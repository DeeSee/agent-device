import { expect, test, vi } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';

const options = {
  session: 'qa-config',
  app: 'ru.yandex.mobile.search',
  containerPath: 'Documents/local_config.json',
};
const receipt = {
  appId: options.app,
  containerPath: options.containerPath,
  sha256: 'a'.repeat(64),
  byteLength: 17,
  value: { enabled: true },
};

test('app JSON read preserves exact request identity and the returned data receipt', async () => {
  const transport = vi.fn<AgentDeviceDaemonTransport>(async () => ({
    ok: true as const,
    data: receipt,
  }));
  const client = createAgentDeviceClient(
    { daemonBaseUrl: 'http://daemon.example.test' },
    { transport },
  );
  expect(await client.apps.files.readJson(options)).toEqual(receipt);
  expect(transport.mock.calls[0]?.[0]).toMatchObject({
    command: 'app_container_read_json',
    session: options.session,
    input: { app: options.app, containerPath: options.containerPath },
  });
});

test('app JSON read refuses a foreign receipt and traversal before sending a request', async () => {
  const transport = vi.fn<AgentDeviceDaemonTransport>(async () => ({
    ok: true as const,
    data: { ...receipt, appId: 'different.app' },
  }));
  const client = createAgentDeviceClient(
    { daemonBaseUrl: 'http://daemon.example.test' },
    { transport },
  );
  await expect(client.apps.files.readJson(options)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
  });
  await expect(
    client.apps.files.readJson({ ...options, containerPath: '../local_config.json' }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(transport).toHaveBeenCalledTimes(1);
});

test('a fill excluded from recording carries that privacy instruction into the daemon request', async () => {
  const transport = vi.fn<AgentDeviceDaemonTransport>(async () => ({
    ok: true as const,
    data: {},
  }));
  const client = createAgentDeviceClient(
    { daemonBaseUrl: 'http://daemon.example.test' },
    { transport },
  );
  await client.interactions.fill({ ref: 'e1', text: 'private input', noRecord: true });
  expect(transport.mock.calls[0]?.[0]).toMatchObject({
    command: 'fill',
    flags: { noRecord: true },
  });
});
