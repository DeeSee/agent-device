import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertDeviceClaimRoot,
  deviceClaimBindingId,
  type DeviceClaimRoot,
} from '../../device-claim-root.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from './device-claim-paths.ts';
import { inspectDeviceClaimFile } from './device-claim-inspection.ts';
import type { DeviceClaimSessionOwnership } from './device-claim-record.ts';
import { withDeviceClaimLock } from './device-claim-store.ts';

/** Verifies that a session-bound operation still owns this exact local target claim. */
export async function assertSessionDeviceClaim(params: {
  device: DeviceInfo;
  session: string;
  stateDir: string;
  ownership: DeviceClaimSessionOwnership | undefined;
  deviceClaimRoot: DeviceClaimRoot;
}): Promise<void> {
  const { ownership, deviceClaimRoot } = params;
  assertDeviceClaimRoot(deviceClaimRoot);
  if (!ownership) {
    throw invalidSessionClaim('device_claim_missing', params.session);
  }
  const expectedDeviceKey = canonicalLocalDeviceKey(params.device);
  if (ownership.deviceKey !== expectedDeviceKey) {
    throw invalidSessionClaim('device_claim_target_mismatch', params.session);
  }
  if (ownership.claimRootId !== deviceClaimRoot.id) {
    throw invalidSessionClaim('device_claim_root_mismatch', params.session);
  }
  if (
    ownership.claimBindingId !==
    deviceClaimBindingId(deviceClaimRoot, ownership.deviceKey, ownership.ownerToken)
  ) {
    throw invalidSessionClaim('device_claim_binding_mismatch', params.session);
  }
  await withDeviceClaimLock(ownership.deviceKey, deviceClaimRoot, async () => {
    const inspected = inspectDeviceClaimFile(
      resolveDeviceClaimPath(ownership.deviceKey, deviceClaimRoot),
    );
    const claim = inspected?.claim;
    if (
      !claim ||
      claim.session !== params.session ||
      claim.stateDir !== params.stateDir ||
      claim.ownerToken !== ownership.ownerToken ||
      claim.ownerPid !== ownership.ownerPid ||
      claim.ownerStartTime !== ownership.ownerStartTime
    ) {
      throw invalidSessionClaim('device_claim_ownership_changed', params.session);
    }
  });
}

function invalidSessionClaim(reason: string, session: string): AppError {
  return new AppError('COMMAND_FAILED', `Session "${session}" no longer owns its device claim.`, {
    reason,
    session,
    hint: `Close session "${session}" to reconcile its ownership before retrying device work.`,
  });
}
