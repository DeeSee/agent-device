import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { createDeviceClaimAdmission } from '../device-claim-admission.ts';
import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from '../device-claim-paths.ts';
import {
  acquireDeviceClaim,
  clearDeviceClaim,
  reconcileOrphanedDeviceClaims,
} from '../device-claims.ts';
import {
  assertDeviceClaimRoot,
  openDeviceClaimRoot,
  type DeviceClaimRoot,
} from '../../../device-claim-root.ts';

vi.mock('@agent-device/host-kit/process', async (importOriginal) =>
  (await import('../../../__tests__/test-utils/host-process-mock.ts')).pinOwnProcessStartTime(
    importOriginal,
  ),
);

const originalMkdirSync = fs.mkdirSync;
const originalRenameSync = fs.renameSync;
const originalUnlinkSync = fs.unlinkSync;
const roots: string[] = [];
const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};
const deviceKey = canonicalLocalDeviceKey(device);

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { base: string; root: DeviceClaimRoot } {
  const base = mkdtempForTestSync('agent-device-claim-root-fencing-');
  roots.push(base);
  return { base, root: openDeviceClaimRoot(path.join(base, 'claims')) };
}

function replaceRoot(
  root: DeviceClaimRoot,
  displacedPath: string,
): { successor: DeviceClaimRoot; successorClaimPath: string } {
  originalRenameSync(root.path, displacedPath);
  originalMkdirSync(root.path, { mode: 0o700 });
  const successor = openDeviceClaimRoot(root.path);
  const successorClaimPath = resolveDeviceClaimPath(deviceKey, successor);
  fs.writeFileSync(successorClaimPath, 'successor-generation');
  return { successor, successorClaimPath };
}

function acquire(root: DeviceClaimRoot, session = 'old-generation') {
  return acquireDeviceClaim({
    device,
    session,
    workspace: '/workspace',
    stateDir: `/state/${session}`,
    deviceClaimRoot: root,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
  });
}

test('a swap immediately before lock creation admits no claim effect', async () => {
  const { base, root } = fixture();
  const oldClaimPath = resolveDeviceClaimPath(deviceKey, root);
  const oldLockPath = `${oldClaimPath}.lock`;
  let successorClaimPath: string | undefined;
  vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
    if (target === oldLockPath && !successorClaimPath) {
      successorClaimPath = replaceRoot(root, path.join(base, 'displaced-lock')).successorClaimPath;
    }
    return originalMkdirSync(target, options);
  });

  await assert.rejects(acquire(root), /stable private directory/);
  assert.equal(fs.readFileSync(successorClaimPath!, 'utf8'), 'successor-generation');
  assert.equal(fs.existsSync(oldClaimPath), false);
});

test('a swap immediately before claim publication cannot replace the successor claim', async () => {
  const { base, root } = fixture();
  const oldClaimPath = resolveDeviceClaimPath(deviceKey, root);
  let successorClaimPath: string | undefined;
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (destination === oldClaimPath && !successorClaimPath) {
      const contents = fs.readFileSync(source, 'utf8');
      successorClaimPath = replaceRoot(
        root,
        path.join(base, 'displaced-publish'),
      ).successorClaimPath;
      // Model an adversarial same-user replacement that recreates the observed
      // temporary name. The generation prefix still prevents replacement of
      // the successor's claim.
      fs.writeFileSync(source, contents);
    }
    return originalRenameSync(source, destination);
  });

  await assert.rejects(acquire(root), /stable private directory/);
  assert.equal(fs.readFileSync(successorClaimPath!, 'utf8'), 'successor-generation');
  assert.deepEqual(
    inspectDeviceClaims({}, openDeviceClaimRoot(root.path)).map((item) => item.fileName),
    [path.basename(successorClaimPath!)],
  );
});

test('a swap immediately before unlink cannot delete the successor claim', async () => {
  const { base, root } = fixture();
  const acquired = await acquire(root);
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;
  const oldClaimPath = resolveDeviceClaimPath(deviceKey, root);
  let successorClaimPath: string | undefined;
  vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
    if (target === oldClaimPath && !successorClaimPath) {
      successorClaimPath = replaceRoot(
        root,
        path.join(base, 'displaced-unlink'),
      ).successorClaimPath;
    }
    return originalUnlinkSync(target);
  });

  await assert.rejects(clearDeviceClaim(acquired.ownership, root), /stable private directory/);
  assert.equal(fs.readFileSync(successorClaimPath!, 'utf8'), 'successor-generation');
  assert.equal(
    fs.existsSync(path.join(base, 'displaced-unlink', path.basename(oldClaimPath))),
    true,
  );
});

test('foreign-generation claim files are ignored', () => {
  const { root } = fixture();
  const foreignName = `${'0'.repeat(64)}.${'1'.repeat(64)}.json`;
  fs.writeFileSync(path.join(root.path, foreignName), '{}');

  assert.deepEqual(inspectDeviceClaims({}, root), []);
});

test('a predecessor lock alone refuses open, validation, and local admission', async () => {
  const { root } = fixture();
  fs.mkdirSync(path.join(root.path, `${'a'.repeat(64)}.json.lock`));

  const expected = (error: unknown) => {
    assert.equal(error instanceof AppError, true);
    if (!(error instanceof AppError)) return false;
    assert.equal(error.details?.reason, 'device_claim_root_legacy_claim_format');
    assert.equal(error.details?.migration, 'clean-root-required');
    return true;
  };
  assert.throws(() => assertDeviceClaimRoot(root), expected);
  assert.throws(() => openDeviceClaimRoot(root.path), expected);
  const admission = createDeviceClaimAdmission({
    policy: 'require-owner',
    command: 'snapshot',
    sessionName: 'default',
    workspace: '/workspace',
    stateDir: '/state/session',
    deviceClaimRoot: root,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
    resolveSession: () => undefined,
  });
  await assert.rejects(
    admission.admit(device, localRuntimeOwner('android'), { kind: 'ordinary' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'device_claim_root_legacy_claim_format',
  );
});

test('require-owner revalidates the root before admitting a local device effect', async () => {
  const { base, root } = fixture();
  const admission = createDeviceClaimAdmission({
    policy: 'require-owner',
    command: 'snapshot',
    sessionName: 'default',
    workspace: '/workspace',
    stateDir: '/state/session',
    deviceClaimRoot: root,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
    resolveSession: () => undefined,
  });
  replaceRoot(root, path.join(base, 'displaced-admission'));

  await assert.rejects(
    admission.admit(device, localRuntimeOwner('android'), { kind: 'ordinary' }),
    /stable private/,
  );
});

test('reconciliation propagates claim-root enumeration failures', async () => {
  const { root } = fixture();
  vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
    const error = new Error('claim root I/O failure') as NodeJS.ErrnoException;
    error.code = 'EIO';
    throw error;
  });

  await assert.rejects(
    reconcileOrphanedDeviceClaims(async () => ({ status: 'reconciled' }), '/state/session', root),
    /stable private directory/,
  );
});
