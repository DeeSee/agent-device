// Copyright 2026 Yandex LLC. All rights reserved.

import type { AppProcessesResult } from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord, readRequiredString, readDeviceTarget } from '@agent-device/kernel/record';
import { buildAppIdentifiers, buildDeviceIdentifiers } from './client-identifiers.ts';

export function requireAppProcessesSession(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('INVALID_ARGS', 'apps.processes requires an explicit session.');
  }
  return value.trim();
}

export function normalizeAppProcessesResult(
  data: Record<string, unknown>,
  session: string,
): AppProcessesResult {
  if (
    !hasExactKeys(data, ['platform', 'appBundleId', 'processIds', 'device']) ||
    data.platform !== 'ios'
  )
    throw invalidObservation();
  const device = readProcessDevice(data.device);
  const processIds = readProcessIds(data.processIds);
  const appBundleId = readRequiredString(data, 'appBundleId');
  const identifiers = { session, ...buildDeviceIdentifiers('ios', device.id, device.name) };
  return {
    platform: 'ios',
    appBundleId,
    processIds,
    device: { ...device, ios: { udid: device.id }, identifiers },
    identifiers: { ...identifiers, ...buildAppIdentifiers({ session, bundleId: appBundleId }) },
  };
}

function readProcessDevice(value: unknown) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['platform', 'appleOs', 'target', 'kind', 'id', 'name'])
  )
    throw invalidObservation();
  if (
    value.platform !== 'ios' ||
    (value.appleOs !== 'ios' && value.appleOs !== 'ipados') ||
    (value.kind !== 'device' && value.kind !== 'simulator')
  )
    throw invalidObservation();
  return {
    platform: 'ios' as const,
    appleOs: value.appleOs,
    kind: value.kind,
    target: readDeviceTarget(value, 'target'),
    id: readRequiredString(value, 'id'),
    name: readRequiredString(value, 'name'),
  } as const;
}

function readProcessIds(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length > 1024) throw invalidObservation();
  if (
    value.some(
      (pid, index) =>
        !Number.isSafeInteger(pid) || pid <= 0 || (index > 0 && value[index - 1] >= pid),
    )
  )
    throw invalidObservation();
  return Object.freeze([...value]);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(record).length === expected.length &&
    expected.every((key) => Object.hasOwn(record, key))
  );
}

function invalidObservation(): AppError {
  return new AppError('COMMAND_FAILED', 'Daemon returned an invalid app process observation.');
}
