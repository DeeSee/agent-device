import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import type { StopLocalDaemon } from '@agent-device/contracts/client';

test('client daemon stop is construction-scoped and concurrent calls are idempotent', async () => {
  const result = {
    kind: 'stopped' as const,
    mode: 'graceful' as const,
    identity: {
      pid: 123,
      processStartTime: 'start-123',
      version: '0.20.10',
      codeSignature: 'graph:1:abc',
      deviceClaimRootId: 'claims-root',
    },
    cleanup: {
      kind: 'complete' as const,
      evidence: {
        providerReleases: { released: [], pending: [] },
        claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
      },
    },
  };
  const stopLocalDaemon = vi.fn(async () => result);
  const client = createAgentDeviceClient(
    {
      stateDir: '/private/state',
      deviceClaimsDir: '/private/claims',
    },
    {
      transport: async () => ({ ok: true, data: {} }),
      stopLocalDaemon,
    },
  );

  const [first, second] = await Promise.all([client.daemon.stop(), client.daemon.stop()]);

  assert.deepEqual(first, result);
  assert.deepEqual(second, first);
  assert.equal(stopLocalDaemon.mock.calls.length, 1);
  assert.deepEqual(stopLocalDaemon.mock.calls[0], [
    {
      stateDir: '/private/state',
      deviceClaimsDir: '/private/claims',
    },
  ]);
});

test('daemon stop refuses missing construction authority before any stop effect', async () => {
  const stopLocalDaemon = vi.fn();
  const client = createAgentDeviceClient(
    {},
    { transport: async () => ({ ok: true, data: {} }), stopLocalDaemon },
  );

  await assert.rejects(
    client.daemon.stop(),
    (error: { details?: { reason?: string } }) =>
      error.details?.reason === 'daemon_stop_authority_not_explicit',
  );
  assert.equal(stopLocalDaemon.mock.calls.length, 0);
});

test('daemon stop refuses a remote daemon before any local stop effect', async () => {
  const stopLocalDaemon = vi.fn();
  const client = createAgentDeviceClient(
    {
      stateDir: '/private/state',
      deviceClaimsDir: '/private/claims',
      daemonBaseUrl: 'https://example.test',
    },
    { transport: async () => ({ ok: true, data: {} }), stopLocalDaemon },
  );

  await assert.rejects(
    client.daemon.stop(),
    (error: { details?: { reason?: string } }) =>
      error.details?.reason === 'daemon_stop_remote_refused',
  );
  assert.equal(stopLocalDaemon.mock.calls.length, 0);
});

test('daemon stop snapshots and refuses an environment-configured remote daemon', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_BASE_URL', 'https://environment.example.test');
  const stopLocalDaemon = vi.fn();
  try {
    const client = createAgentDeviceClient(
      { stateDir: '/private/state', deviceClaimsDir: '/private/claims' },
      { transport: async () => ({ ok: true, data: {} }), stopLocalDaemon },
    );
    vi.unstubAllEnvs();

    await assert.rejects(
      client.daemon.stop(),
      (error: { details?: { reason?: string } }) =>
        error.details?.reason === 'daemon_stop_remote_refused',
    );
    assert.equal(stopLocalDaemon.mock.calls.length, 0);
  } finally {
    vi.unstubAllEnvs();
  }
});

test('not-running is a retryable observation rather than a permanent client result', async () => {
  const notRunning = {
    kind: 'not_running' as const,
    mode: 'not_running' as const,
    identity: null,
    cleanup: { kind: 'unknown' as const, reason: 'daemon_not_running' as const },
  };
  const stopLocalDaemon = vi.fn(async () => notRunning);
  const client = createAgentDeviceClient(
    { stateDir: '/private/state', deviceClaimsDir: '/private/claims' },
    { transport: async () => ({ ok: true, data: {} }), stopLocalDaemon },
  );

  assert.deepEqual(await client.daemon.stop(), notRunning);
  assert.deepEqual(await client.daemon.stop(), notRunning);
  assert.equal(stopLocalDaemon.mock.calls.length, 2);
});

test('a later request invalidates a cached graceful stop result', async () => {
  const stopped = {
    kind: 'stopped' as const,
    mode: 'graceful' as const,
    identity: {
      pid: 123,
      processStartTime: 'start-123',
      version: '0.20.10',
      codeSignature: 'graph:1:abc',
      deviceClaimRootId: 'claims-root',
    },
    cleanup: {
      kind: 'complete' as const,
      evidence: {
        providerReleases: { released: [], pending: [] },
        claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
      },
    },
  };
  const stopLocalDaemon = vi.fn(async () => stopped);
  const client = createAgentDeviceClient(
    { stateDir: '/private/state', deviceClaimsDir: '/private/claims' },
    {
      transport: async () => ({ ok: true, data: { devices: [] } }),
      stopLocalDaemon,
    },
  );

  await client.daemon.stop();
  await client.devices.list();
  await client.daemon.stop();

  assert.equal(stopLocalDaemon.mock.calls.length, 2);
});

test('a graceful timeout is retryable while concurrent calls still share one effect', async () => {
  const timeout = {
    kind: 'still_running' as const,
    mode: 'grace_timeout' as const,
    identity: {
      pid: 123,
      processStartTime: 'start-123',
      version: '0.20.10',
      codeSignature: 'graph:1:abc',
      deviceClaimRootId: 'claims-root',
    },
    cleanup: { kind: 'unknown' as const, reason: 'grace_timeout' as const },
  };
  const stopLocalDaemon = vi.fn(async () => timeout);
  const client = createAgentDeviceClient(
    { stateDir: '/private/state', deviceClaimsDir: '/private/claims' },
    { transport: async () => ({ ok: true, data: {} }), stopLocalDaemon },
  );

  const [first, sameAttempt] = await Promise.all([client.daemon.stop(), client.daemon.stop()]);
  const retry = await client.daemon.stop();

  assert.deepEqual(first, timeout);
  assert.deepEqual(sameAttempt, timeout);
  assert.deepEqual(retry, timeout);
  assert.equal(stopLocalDaemon.mock.calls.length, 2);
});

test('a synchronously thrown injected stop does not leave the client stopping', async () => {
  const stopped = {
    kind: 'not_running' as const,
    mode: 'not_running' as const,
    identity: null,
    cleanup: { kind: 'unknown' as const, reason: 'daemon_not_running' as const },
  };
  let attempts = 0;
  const stopLocalDaemon = vi.fn<StopLocalDaemon>(() => {
    attempts += 1;
    if (attempts === 1) throw new Error('synchronous injected failure');
    return Promise.resolve(stopped);
  });
  const client = createAgentDeviceClient(
    { stateDir: '/private/state', deviceClaimsDir: '/private/claims' },
    { transport: async () => ({ ok: true, data: {} }), stopLocalDaemon },
  );

  await assert.rejects(client.daemon.stop(), /synchronous injected failure/);
  assert.deepEqual(await client.daemon.stop(), stopped);
  assert.equal(stopLocalDaemon.mock.calls.length, 2);
});
