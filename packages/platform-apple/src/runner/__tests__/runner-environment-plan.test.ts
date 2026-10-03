import { expect, test, vi } from 'vitest';
import { prepareRunnerEnvironment } from '../runner-environment-plan.ts';

test('every external runner gets one fresh session-owned environment overlay', async () => {
  const allocatePort = vi.fn(async () => 8124);
  const prepareOverlay = vi.fn(async () => ({
    xctestrunPath: '/private/env/AgentDeviceRunner.env.xctestrun',
    jsonPath: '/private/env/AgentDeviceRunner.env.json',
  }));

  const result = await prepareRunnerEnvironment({
    baseXctestrunPath: '/private/run/Products/Prepared.xctestrun',
    deviceId: 'device-1',
    ownerToken: 'owner-1',
    allocatePort,
    prepareOverlay,
  });

  expect(result).toEqual({
    port: 8124,
    xctestrunPath: '/private/env/AgentDeviceRunner.env.xctestrun',
    ownedEnvironmentFiles: [
      '/private/env/AgentDeviceRunner.env.xctestrun',
      '/private/env/AgentDeviceRunner.env.json',
    ],
  });
  expect(allocatePort).toHaveBeenCalledOnce();
  expect(prepareOverlay).toHaveBeenCalledWith(
    '/private/run/Products/Prepared.xctestrun',
    { AGENT_DEVICE_RUNNER_PORT: '8124' },
    'session-device-1-owner-1-8124',
    { iosXctestEnvDir: undefined },
  );
});

test('unmarked selection retains one legacy generated overlay', async () => {
  const allocatePort = vi.fn(async () => 8123);
  const prepareOverlay = vi.fn(async () => ({
    xctestrunPath: '/private/env/AgentDeviceRunner.env.xctestrun',
    jsonPath: '/private/env/AgentDeviceRunner.env.json',
  }));

  const result = await prepareRunnerEnvironment({
    baseXctestrunPath: '/private/run/Products/Base.xctestrun',
    deviceId: 'device-1',
    ownerToken: 'owner-1',
    iosXctestEnvDir: '/private/env',
    allocatePort,
    prepareOverlay,
  });

  expect(result).toEqual({
    port: 8123,
    xctestrunPath: '/private/env/AgentDeviceRunner.env.xctestrun',
    ownedEnvironmentFiles: [
      '/private/env/AgentDeviceRunner.env.xctestrun',
      '/private/env/AgentDeviceRunner.env.json',
    ],
  });
  expect(prepareOverlay).toHaveBeenCalledWith(
    '/private/run/Products/Base.xctestrun',
    { AGENT_DEVICE_RUNNER_PORT: '8123' },
    'session-device-1-owner-1-8123',
    { iosXctestEnvDir: '/private/env' },
  );
});

test('a restart excludes the failed listener port before preparing its overlay', async () => {
  const allocatePort = vi.fn().mockResolvedValueOnce(8123).mockResolvedValueOnce(8124);
  const prepareOverlay = vi.fn(async () => ({
    xctestrunPath: '/private/env/AgentDeviceRunner.env.xctestrun',
    jsonPath: '/private/env/AgentDeviceRunner.env.json',
  }));

  const result = await prepareRunnerEnvironment({
    baseXctestrunPath: '/private/run/Products/Prepared.xctestrun',
    deviceId: 'device-1',
    ownerToken: 'owner-1',
    excludedPort: 8123,
    allocatePort,
    prepareOverlay,
  });

  expect(result.port).toBe(8124);
  expect(allocatePort).toHaveBeenCalledTimes(2);
  expect(prepareOverlay).toHaveBeenCalledWith(
    '/private/run/Products/Prepared.xctestrun',
    { AGENT_DEVICE_RUNNER_PORT: '8124' },
    'session-device-1-owner-1-8124',
    { iosXctestEnvDir: undefined },
  );
});

test('excluded port exhaustion fails before preparing an overlay', async () => {
  const allocatePort = vi.fn(async () => 8123);
  const prepareOverlay = vi.fn();

  await expect(
    prepareRunnerEnvironment({
      baseXctestrunPath: '/private/run/Products/Prepared.xctestrun',
      deviceId: 'device-1',
      ownerToken: 'owner-1',
      excludedPort: 8123,
      allocatePort,
      prepareOverlay,
    }),
  ).rejects.toMatchObject({
    details: { reason: 'runner_port_allocation_exhausted' },
  });
  expect(allocatePort).toHaveBeenCalledTimes(8);
  expect(prepareOverlay).not.toHaveBeenCalled();
});
