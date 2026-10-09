// Copyright 2026 Yandex LLC. All rights reserved.

import { expect, test, vi } from 'vitest';
import { localRuntimeOwner, narrowDeviceBinding } from '@agent-device/contracts/platform-runtime';
import { handleAppProcessesCommand } from '../session-app-processes.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { makeIosAppSession } from '../../../__tests__/test-utils/session-factories.ts';
import { createUnavailableRuntimeFactsForTest } from '../../../__tests__/test-utils/runtime-operation-facts.ts';
import type { BindDeviceRuntime } from '../../request-runtime-binding.ts';

const req = {
  token: 't',
  session: 'case-session',
  command: 'app_processes',
  positionals: [],
  flags: {},
};

test('a reservation without an app refuses before runtime inspection', async () => {
  const sessionStore = makeSessionStore();
  const inspectFacts = vi.fn();
  expect(
    await handleAppProcessesCommand({
      req,
      sessionName: 'case-session',
      sessionStore,
      inspectFacts,
    }),
  ).toMatchObject({ ok: false, error: { code: 'SESSION_NOT_FOUND' } });
  expect(inspectFacts).not.toHaveBeenCalled();
});

test('session-bound process observation returns an empty stopped-app set without UI dispatch', async () => {
  const sessionStore = makeSessionStore();
  const session = makeIosAppSession('case-session');
  sessionStore.set('case-session', session);
  const owner = localRuntimeOwner('apple');
  const unavailable = createUnavailableRuntimeFactsForTest(session.device, owner);
  const facts = {
    ...unavailable,
    operations: { ...unavailable.operations, observeAppProcesses: { available: true as const } },
  };
  const observeAppProcesses = vi.fn(async () => ({ processIds: [] }));
  const bindDevice: BindDeviceRuntime = async (device, use) =>
    narrowDeviceBinding(
      {
        device,
        owner,
        facts,
        operations: { observeAppProcesses },
        [Symbol.asyncDispose]: async () => {},
      },
      use,
    );
  const result = await handleAppProcessesCommand({
    req,
    sessionName: 'case-session',
    sessionStore,
    inspectFacts: async () => facts,
    bindDevice,
  });
  expect(result).toMatchObject({
    ok: true,
    data: {
      platform: 'ios',
      appBundleId: 'com.example.app',
      processIds: [],
      device: { platform: 'ios', kind: 'simulator' },
    },
  });
  expect(observeAppProcesses).toHaveBeenCalledWith({ appBundleId: 'com.example.app' });
});

test('unsupported facts refuse before native binding', async () => {
  const sessionStore = makeSessionStore();
  const session = makeIosAppSession('case-session');
  sessionStore.set('case-session', session);
  const bindDevice = vi.fn();
  const result = await handleAppProcessesCommand({
    req,
    sessionName: 'case-session',
    sessionStore,
    inspectFacts: async () =>
      createUnavailableRuntimeFactsForTest(session.device, localRuntimeOwner('apple')),
    bindDevice: bindDevice as BindDeviceRuntime,
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } });
  expect(bindDevice).not.toHaveBeenCalled();
});
