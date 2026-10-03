import {
  isApplePlatform,
  isIosFamily,
  isSerialAddressablePlatform,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { assertSessionDeviceClaim } from '../../device/device-claim-authority.ts';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import { isActiveProviderDevice } from '../../provider-device-admission.ts';
import { buildDeviceClaimConflictError } from '../../device/device-claim-conflict.ts';
import {
  acquireDeviceClaim,
  clearDeviceClaim,
  type DeviceClaimReconciler,
} from '../../device/device-claims.ts';
import { resolveImplicitSessionScope, resolvePublicSessionName } from '../../session-routing.ts';
import { SessionStore } from '../../session-store.ts';
import { assertSessionSelectorMatches } from '../../session-selector.ts';
import type { DaemonRequest, DaemonResponse } from '../../daemon-request.ts';
import type { SessionState } from '../../session-state.ts';
import { buildDeviceInUseBySessionError } from '../../session-recovery-hints.ts';
import { errorResponse } from '@agent-device/kernel/contracts';

export async function handleSessionReserveCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  retainDeviceExecutionLock?: (deviceId: string) => Promise<void>;
  throwIfCanceled?: () => void;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  if (!hasExactTargetSelector(req)) {
    return errorResponse(
      'INVALID_ARGS',
      'Session reservation requires an exact --device, --udid, or --serial selector.',
    );
  }

  const existing = sessionStore.get(sessionName);
  if (existing) {
    assertSessionSelectorMatches({ address: sessionName, session: existing }, req.flags);
    if (existing.deviceClaim?.reservationPhase !== 'reserved') {
      return reservationStateConflict(existing);
    }
    await assertSessionDeviceClaim({
      device: existing.device,
      session: sessionName,
      stateDir: sessionStore.resolveDaemonStateDir(),
      ownership: existing.deviceClaim,
      deviceClaimRoot: sessionStore.resolveDeviceClaimRoot(),
    });
    return reserveSuccess(existing, 'already_reserved');
  }

  const device = await resolveTargetDevice(req.flags ?? {});
  if (isActiveProviderDevice(device)) {
    return errorResponse(
      'UNSUPPORTED_PLATFORM',
      'Session reservation supports host-local devices only; provider devices use lease authority.',
    );
  }
  await params.retainDeviceExecutionLock?.(device.id);
  const inUse = sessionStore.toArray().find((session) => session.device.id === device.id);
  if (inUse)
    return buildDeviceInUseBySessionError(
      { address: sessionStore.resolveStoredSessionName(inUse), session: inUse },
      device,
    );

  const acquired = await acquireDeviceClaim({
    device,
    session: sessionName,
    workspace: req.meta?.cwd ?? process.cwd(),
    stateDir: sessionStore.resolveDaemonStateDir(),
    deviceClaimRoot: sessionStore.resolveDeviceClaimRoot(),
    reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
  });
  if (acquired.status === 'conflict') {
    return buildDeviceClaimConflictError(device, acquired.conflict);
  }

  const reserved: SessionState = {
    name: resolvePublicSessionName(req),
    sessionScope: resolveImplicitSessionScope(req),
    device,
    deviceClaim: { ...acquired.ownership, reservationPhase: 'reserved' },
    createdAt: Date.now(),
    actions: [],
  };
  try {
    params.throwIfCanceled?.();
    sessionStore.set(sessionName, reserved);
    return reserveSuccess(reserved, 'created');
  } catch (error) {
    await clearDeviceClaim(acquired.ownership, sessionStore.resolveDeviceClaimRoot());
    throw error;
  }
}

function hasExactTargetSelector(req: DaemonRequest): boolean {
  const flags = req.flags ?? {};
  const keys = (['device', 'udid', 'serial'] as const).filter((key) => Object.hasOwn(flags, key));
  if (keys.length !== 1) return false;
  const value = flags[keys[0]!];
  return typeof value === 'string' && value.trim().length > 0;
}

function reservationStateConflict(session: SessionState): DaemonResponse {
  return errorResponse(
    'COMMAND_FAILED',
    `Session "${session.name}" is not an unlaunched reservation.`,
    {
      session: session.name,
      reason: 'session_reservation_conflict',
      lifecyclePhase: session.deviceClaim?.reservationPhase ?? 'opened',
    },
  );
}

function reserveSuccess(
  session: SessionState,
  status: 'created' | 'already_reserved',
): DaemonResponse {
  return {
    ok: true,
    data: {
      session: session.name,
      status,
      ...publicTargetIdentity(session.device),
    },
  };
}

function publicTargetIdentity(device: DeviceInfo): Record<string, unknown> {
  const platform = publicPlatformString(device);
  return {
    platform,
    target: device.target ?? 'mobile',
    device: device.name,
    id: device.id,
    kind: device.kind,
    ...(isSerialAddressablePlatform(device.platform) ? { serial: device.id } : {}),
    ...(isApplePlatform(device.platform) && device.appleOs ? { appleOs: device.appleOs } : {}),
    ...(isIosFamily(device)
      ? {
          device_udid: device.id,
          ios_simulator_device_set: device.simulatorSetPath ?? null,
        }
      : {}),
  };
}
