import { assertDeviceClaimRoot, type DeviceClaimRoot } from '../../device-claim-root.ts';
import { publishFileSync, acquireProcessLock, withProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';

import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import type { StoredDeviceClaim } from './device-claim-record.ts';

const DEVICE_CLAIM_LOCK_TIMEOUT_MS = 30_000;

/** The single writer of a claim file, shared by the process-owned and allocator-held kinds. */
export function writeDeviceClaim(claim: StoredDeviceClaim, root: DeviceClaimRoot): void {
  const claimPath = resolveDeviceClaimPath(claim.deviceKey, root);
  assertDeviceClaimRoot(root);
  publishFileSync({
    destination: claimPath,
    contents: `${JSON.stringify(claim)}\n`,
    mode: 0o600,
  });
  assertDeviceClaimRoot(root);
}

/** The host-global per-device mutual exclusion every claim write and clear runs under. */
export async function withDeviceClaimLock<T>(
  deviceKey: string,
  root: DeviceClaimRoot,
  task: () => Promise<T>,
): Promise<T> {
  assertDeviceClaimRoot(root);
  const owner = readCurrentOwnerIdentity();
  try {
    return await withProcessLock({
      acquire: () =>
        acquireProcessLock({
          lockDirPath: `${resolveDeviceClaimPath(deviceKey, root)}.lock`,
          owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
          timeoutMs: DEVICE_CLAIM_LOCK_TIMEOUT_MS,
          description: `device claim for ${deviceKey}`,
        }),
      task: async () => {
        assertDeviceClaimRoot(root);
        return await task();
      },
    });
  } finally {
    assertDeviceClaimRoot(root);
  }
}
