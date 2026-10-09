// Copyright 2026 Yandex LLC. All rights reserved.

import type { AppProcessesRuntimeOperations } from '@agent-device/contracts/app-processes-runtime';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';
import { observeIosAppProcesses } from './core/app-processes.ts';

export function appleAppProcessesFact(device: DeviceInfo): RuntimeOperationFact {
  const leaf = resolveDeviceAppleOs(device);
  if (leaf !== 'ios' && leaf !== 'ipados') {
    return {
      available: false,
      reason: 'unsupported-platform-leaf',
      hint: 'App process observation is supported only for iOS and iPadOS.',
    };
  }
  if (device.kind !== 'simulator' && device.kind !== 'device') {
    return { available: false, reason: 'unsupported-device-kind' };
  }
  if (device.kind === 'device' && device.iosPhysicalDeviceBackend === 'xctest') {
    return {
      available: false,
      reason: 'unsupported-device-backend',
      hint: 'Physical-device process observation requires CoreDevice.',
    };
  }
  return { available: true };
}

export function createAppleAppProcessesOperations(params: {
  device: DeviceInfo;
  signal: AbortSignal;
}): AppProcessesRuntimeOperations {
  return {
    observeAppProcesses: async (input) =>
      await observeIosAppProcesses(params.device, input.appBundleId, params.signal),
  };
}
