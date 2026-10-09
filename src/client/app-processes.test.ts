// Copyright 2026 Yandex LLC. All rights reserved.

import { expect, test } from 'vitest';
import { normalizeAppProcessesResult, requireAppProcessesSession } from './app-processes.ts';

const data = {
  platform: 'ios',
  appBundleId: 'com.example.app',
  processIds: [3, 22],
  device: {
    platform: 'ios',
    appleOs: 'ios',
    target: 'mobile',
    kind: 'device',
    id: 'device-id',
    name: 'iPhone',
  },
};

test('process observation preserves session, device and app identity with an immutable pid set', () => {
  const result = normalizeAppProcessesResult(data, 'case-session');
  expect(result).toMatchObject({
    processIds: [3, 22],
    identifiers: { session: 'case-session', udid: 'device-id', appBundleId: 'com.example.app' },
    device: { ios: { udid: 'device-id' } },
  });
  expect(Object.isFrozen(result.processIds)).toBe(true);
  expect(
    normalizeAppProcessesResult({ ...data, processIds: [] }, 'case-session').processIds,
  ).toEqual([]);
});

test.each([undefined, null, '', '  '])(
  'process observation requires an explicit session: %s',
  (session) => {
    expect(() => requireAppProcessesSession(session)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGS' }),
    );
  },
);

test.each([
  { ...data, executable: '/private/app/path' },
  { ...data, platform: 'apple' },
  { ...data, device: { ...data.device, platform: 'apple' } },
  { ...data, device: { ...data.device, executable: '/private/app/path' } },
  { ...data, processIds: [22, 3] },
  { ...data, processIds: [3, 3] },
  { ...data, processIds: [0] },
  { ...data, processIds: ['3'] },
  { ...data, processIds: Array.from({ length: 1025 }, (_, index) => index + 1) },
])('rejects process payloads that violate the closed public contract', (raw) => {
  expect(() => normalizeAppProcessesResult(raw, 'case-session')).toThrow(
    expect.objectContaining({ code: 'COMMAND_FAILED' }),
  );
});
