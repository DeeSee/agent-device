import crypto from 'node:crypto';
import path from 'node:path';
import {
  type AppleOS,
  type DeviceIdentity,
  type DeviceInfo,
  type Platform,
} from '@agent-device/kernel/device';
import { assertDeviceClaimRoot, type DeviceClaimRoot } from '../../device-claim-root.ts';

export function canonicalLocalDeviceKey(device: DeviceInfo | DeviceIdentity): string {
  return formatLocalDeviceKey(
    'family' in device ? device.family : device.platform,
    device.appleOs,
    device.id,
  );
}

function formatLocalDeviceKey(
  platform: Platform,
  appleOs: AppleOS | undefined,
  id: string,
): string {
  return `local:${platform}:${appleOs ?? 'none'}:${id}`;
}

export function resolveDeviceClaimPath(deviceKey: string, root: DeviceClaimRoot): string {
  assertDeviceClaimRoot(root);
  const hash = crypto.createHash('sha256').update(deviceKey).digest('hex');
  return path.join(root.path, `${root.id}.${hash}.json`);
}

export function isDeviceClaimFileNameForRoot(fileName: string, root: DeviceClaimRoot): boolean {
  return new RegExp(`^${root.id}\\.[a-f0-9]{64}\\.json$`, 'u').test(fileName);
}
