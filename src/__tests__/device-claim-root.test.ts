import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest } from '../daemon/daemon-request.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';
import { resolveClientSettings } from '../daemon-client/daemon-client-settings.ts';
import { readDaemonInfo } from '../daemon-client/daemon-client-metadata.ts';
import { readDaemonEntrypointOptions } from '../daemon/daemon-entrypoint-options.ts';
import {
  assertDeviceClaimRoot,
  openDeviceClaimRoot,
  resolveDeviceClaimRootPath,
} from '../device-claim-root.ts';
import { acquireDeviceClaim, clearDeviceClaim } from '../daemon/device/device-claims.ts';
import { SessionStore } from '../daemon/session-store.ts';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { AppError } from '@agent-device/kernel/errors';

vi.mock('@agent-device/host-kit/process', async (importOriginal) =>
  (await import('./test-utils/host-process-mock.ts')).pinOwnProcessStartTime(importOriginal),
);

const roots: string[] = [];
const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempForTestSync(prefix);
  roots.push(root);
  return root;
}

function request(flags: NonNullable<DaemonRequest['flags']>): Omit<DaemonRequest, 'token'> {
  return { session: 'qa', command: 'devices', positionals: [], flags };
}

test('explicit client claim root defeats the process environment and is fingerprinted', () => {
  const stateDir = tempRoot('agent-device-claim-config-state-');
  const explicitRoot = path.join(tempRoot('agent-device-claim-config-explicit-'), 'claims');
  const environmentRoot = path.join(tempRoot('agent-device-claim-config-env-'), 'claims');
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', environmentRoot);

  const settings = resolveClientSettings(request({ stateDir }), undefined, explicitRoot);

  assert.equal(settings.deviceClaimRoot?.path, openDeviceClaimRoot(explicitRoot).path);
  assert.equal(settings.deviceClaimRoot?.id, openDeviceClaimRoot(explicitRoot).id);
  assert.equal(settings.explicitDeviceClaimsDir, true);
  assert.equal(resolveDeviceClaimRootPath(explicitRoot), path.resolve(explicitRoot));
});

test('public client snapshots explicit and environment claim roots outside requests', async () => {
  const constructionCwd = tempRoot('agent-device-claim-client-cwd-');
  const laterCwd = tempRoot('agent-device-claim-client-later-cwd-');
  const claimsDir = 'relative-claims';
  const mutatedClaimsDir = path.join(tempRoot('agent-device-claim-client-mutated-'), 'claims');
  const requestClaimsDir = path.join(tempRoot('agent-device-claim-request-'), 'claims');
  const config = { deviceClaimsDir: claimsDir };
  const seen: Array<{ contextRoot: unknown; contextExplicit: unknown; requestRoot: unknown }> = [];
  const originalCwd = process.cwd();
  try {
    process.chdir(constructionCwd);
    const client = createAgentDeviceClient(config, {
      transport: async (req, context) => {
        seen.push({
          contextRoot: context?.deviceClaimsDir,
          contextExplicit: context?.deviceClaimsDirExplicit,
          requestRoot: (req.flags as Record<string, unknown> | undefined)?.deviceClaimsDir,
        });
        return { ok: true, data: { devices: [] } };
      },
    });

    config.deviceClaimsDir = mutatedClaimsDir;
    process.chdir(laterCwd);
    await client.devices.list();
    await client.devices.list({ deviceClaimsDir: requestClaimsDir } as never);
  } finally {
    process.chdir(originalCwd);
  }

  const normalizedRoot = path.join(fs.realpathSync.native(constructionCwd), claimsDir);
  assert.deepEqual(seen, [
    { contextRoot: normalizedRoot, contextExplicit: true, requestRoot: undefined },
    { contextRoot: normalizedRoot, contextExplicit: true, requestRoot: undefined },
  ]);

  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', claimsDir);
  const environmentRoots: Array<{ path: unknown; explicit: unknown }> = [];
  try {
    process.chdir(constructionCwd);
    const environmentClient = createAgentDeviceClient(
      {},
      {
        transport: async (_req, context) => {
          environmentRoots.push({
            path: context?.deviceClaimsDir,
            explicit: context?.deviceClaimsDirExplicit,
          });
          return { ok: true, data: { devices: [] } };
        },
      },
    );
    vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', mutatedClaimsDir);
    process.chdir(laterCwd);
    await environmentClient.devices.list();
  } finally {
    process.chdir(originalCwd);
  }
  assert.deepEqual(environmentRoots, [{ path: normalizedRoot, explicit: false }]);

  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', '');
  const defaultRoot = resolveDeviceClaimRootPath();
  let absentSnapshot: unknown;
  const defaultClient = createAgentDeviceClient(
    {},
    {
      transport: async (_req, context) => {
        absentSnapshot = context?.deviceClaimsDir;
        return { ok: true, data: { devices: [] } };
      },
    },
  );
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', mutatedClaimsDir);
  await defaultClient.devices.list();
  assert.equal(absentSnapshot, defaultRoot);

  const remote = resolveClientSettings(
    request({ daemonBaseUrl: 'http://127.0.0.1:8123' }),
    'token',
    defaultRoot,
    false,
  );
  assert.equal(remote.remoteBaseUrl, 'http://127.0.0.1:8123');
  assert.equal(remote.deviceClaimRoot, undefined);
});

test('blank client claim root is refused instead of falling back', () => {
  assert.throws(
    () => createAgentDeviceClient({ deviceClaimsDir: '   ' }),
    /deviceClaimsDir must be a non-empty string/,
  );
});

test('daemon entrypoint accepts one typed claim-root argument only', () => {
  assert.deepEqual(readDaemonEntrypointOptions([]), {});
  assert.deepEqual(readDaemonEntrypointOptions(['--device-claims-dir', '/private/claims']), {
    deviceClaimsDir: '/private/claims',
  });
  assert.throws(() => readDaemonEntrypointOptions(['--device-claims-dir', '']), /non-empty path/);
  assert.throws(() => readDaemonEntrypointOptions(['--unknown', '/tmp']), /accepts only/);
});

test('session store retains the immutable configured claim root', () => {
  const stateDir = tempRoot('agent-device-claim-store-state-');
  const claimsDir = path.join(tempRoot('agent-device-claim-store-root-'), 'claims');
  const root = openDeviceClaimRoot(claimsDir);
  const store = new SessionStore(path.join(stateDir, 'sessions'), { deviceClaimRoot: root });
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', '/later/environment/root');

  assert.equal(store.resolveDeviceClaimRoot(), root);
});

test('claim ownership cannot be released through a different root', async () => {
  const firstRoot = path.join(tempRoot('agent-device-claim-owner-a-'), 'claims');
  const secondRoot = path.join(tempRoot('agent-device-claim-owner-b-'), 'claims');
  const firstCapability = openDeviceClaimRoot(firstRoot);
  const secondCapability = openDeviceClaimRoot(secondRoot);
  const acquired = await acquireDeviceClaim({
    device,
    session: 'first',
    workspace: '/workspace',
    stateDir: '/state/first',
    deviceClaimRoot: firstCapability,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;

  await assert.rejects(
    clearDeviceClaim(acquired.ownership, secondCapability),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'device_claim_root_mismatch',
  );
  assert.equal(await clearDeviceClaim(acquired.ownership, firstCapability), 'deleted');
});

test('configured claim-root symlink is refused', () => {
  const base = tempRoot('agent-device-claim-root-symlink-');
  const target = path.join(base, 'target');
  const link = path.join(base, 'claims');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, link, 'dir');

  assert.throws(() => openDeviceClaimRoot(link), /stable private directory/);
});

test('an unscoped predecessor claim enforces the clean-root cutover precondition', () => {
  const root = openDeviceClaimRoot(path.join(tempRoot('agent-device-legacy-claim-'), 'claims'));
  fs.writeFileSync(path.join(root.path, `${'a'.repeat(64)}.json`), '{}');

  const expected = (error: unknown) => {
    assert.equal(error instanceof AppError, true);
    if (!(error instanceof AppError)) return false;
    assert.equal(error.details?.reason, 'device_claim_root_legacy_claim_format');
    assert.equal(error.details?.migration, 'clean-root-required');
    assert.match(String(error.details?.hint), /Stop every agent-device daemon/);
    return true;
  };
  assert.throws(() => assertDeviceClaimRoot(root), expected);
  assert.throws(() => openDeviceClaimRoot(root.path), expected);
});

test('same-path root replacement refuses acquire and release without touching either tree', async () => {
  const base = tempRoot('agent-device-claim-root-swap-');
  const configuredPath = path.join(base, 'claims');
  const displacedPath = path.join(base, 'claims-original');
  const root = openDeviceClaimRoot(configuredPath);
  const acquired = await acquireDeviceClaim({
    device,
    session: 'first',
    workspace: '/workspace',
    stateDir: '/state/first',
    deviceClaimRoot: root,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;
  const originalEntries = fs.readdirSync(configuredPath);

  fs.renameSync(configuredPath, displacedPath);
  fs.mkdirSync(configuredPath, { mode: 0o700 });

  await assert.rejects(
    acquireDeviceClaim({
      device,
      session: 'second',
      workspace: '/workspace',
      stateDir: '/state/second',
      deviceClaimRoot: root,
      reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
    }),
    /stable private directory/,
  );
  await assert.rejects(clearDeviceClaim(acquired.ownership, root), /stable private directory/);
  assert.deepEqual(fs.readdirSync(displacedPath), originalEntries);
  assert.deepEqual(fs.readdirSync(configuredPath), []);
});

test('unbound ownership cannot authorize release', async () => {
  const root = openDeviceClaimRoot(path.join(tempRoot('agent-device-unbound-claim-'), 'claims'));
  const acquired = await acquireDeviceClaim({
    device,
    session: 'first',
    workspace: '/workspace',
    stateDir: '/state/first',
    deviceClaimRoot: root,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;
  const unbound = { ...acquired.ownership } as Partial<typeof acquired.ownership>;
  delete unbound.claimRootId;
  delete unbound.claimBindingId;

  await assert.rejects(
    clearDeviceClaim(unbound as typeof acquired.ownership, root),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'device_claim_root_mismatch',
  );
});

test('daemon metadata preserves only the claim-root fingerprint', () => {
  const root = tempRoot('agent-device-claim-metadata-');
  const infoPath = path.join(root, 'daemon.json');
  const claimRoot = openDeviceClaimRoot(path.join(root, 'claims'));
  const rootId = claimRoot.id;
  fs.writeFileSync(
    infoPath,
    JSON.stringify({ port: 1234, token: 'token', pid: 42, deviceClaimRootId: rootId }),
  );

  const info = readDaemonInfo(infoPath);
  assert.equal(info?.deviceClaimRootId, rootId);
  assert.equal(JSON.stringify(info).includes(claimRoot.path), false);
});
