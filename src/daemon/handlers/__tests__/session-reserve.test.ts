import path from 'node:path';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { expect, test, vi } from 'vitest';
import {
  currentTestDeviceClaimRoot,
  inspectTestDeviceClaims,
  isolatedDeviceClaimStores,
} from '../../../__tests__/test-utils/device-claim-store.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest } from '../../daemon-request.ts';
import type { SessionState } from '../../session-state.ts';
import {
  mockLifecycleDispatch,
  mockResolveIosApp,
  mockResolveTargetDevice,
  noopInvoke,
} from './session-test-harness.ts';
import { handleSessionCommands } from './session-command-harness.ts';

const setup = isolatedDeviceClaimStores('agent-device-session-reserve-');
const DEVICE: SessionState['device'] = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'physical-iphone-1',
  name: 'iPhone',
  kind: 'device',
  target: 'mobile',
  booted: true,
  iosPhysicalDeviceBackend: 'coredevice',
};

function reserveRequest(session = 'qa-case', udid = DEVICE.id): DaemonRequest {
  return {
    token: 't',
    session,
    command: 'session_reserve',
    positionals: [],
    flags: { platform: 'ios', target: 'mobile', udid },
    meta: { cwd: '/worktree', sessionExplicit: true },
  };
}

function store(stateDir: string, suffix = 'sessions'): SessionStore {
  return new SessionStore(path.join(stateDir, suffix), {
    deviceClaimRoot: currentTestDeviceClaimRoot(),
  });
}

async function reserve(
  sessionStore: SessionStore,
  req = reserveRequest(),
  overrides: {
    throwIfCanceled?: () => void;
    retainDeviceExecutionLock?: (deviceId: string) => Promise<void>;
  } = {},
) {
  return await handleSessionCommands({
    req,
    sessionName: req.session ?? 'default',
    logPath: path.join(sessionStore.resolveDaemonStateDir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
    ...overrides,
  });
}

test('reserve acquires one exact claim without binding or launching a runtime', async () => {
  const { stateDir } = setup();
  const sessionStore = store(stateDir);
  const retainDeviceExecutionLock = vi.fn(async () => {});
  mockResolveTargetDevice.mockResolvedValue(DEVICE);

  const response = await reserve(sessionStore, reserveRequest(), { retainDeviceExecutionLock });

  expect(response).toMatchObject({
    ok: true,
    data: {
      session: 'qa-case',
      status: 'created',
      platform: 'ios',
      target: 'mobile',
      id: DEVICE.id,
      device: DEVICE.name,
    },
  });
  expect(retainDeviceExecutionLock).toHaveBeenCalledWith(DEVICE.id);
  expect(sessionStore.get('qa-case')).toMatchObject({
    device: DEVICE,
    deviceClaim: { reservationPhase: 'reserved' },
  });
  expect(inspectTestDeviceClaims({})).toHaveLength(1);
});

test.each([
  {},
  { udid: '' },
  { udid: DEVICE.id, device: DEVICE.name },
  { udid: DEVICE.id, serial: DEVICE.id },
])('reserve refuses a missing, blank, or conflicting exact selector: %j', async (selector) => {
  const { stateDir } = setup();
  const sessionStore = store(stateDir);
  const request = reserveRequest();
  request.flags = { platform: 'ios', target: 'mobile', ...selector };

  const response = await reserve(sessionStore, request);

  expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
  expect(inspectTestDeviceClaims({})).toEqual([]);
});

test('exact retry adopts the reservation while a changed target fails closed', async () => {
  const { stateDir } = setup();
  const sessionStore = store(stateDir);
  mockResolveTargetDevice.mockResolvedValue(DEVICE);
  await reserve(sessionStore);
  mockResolveTargetDevice.mockClear();

  const adopted = await reserve(sessionStore);
  expect(adopted).toMatchObject({ ok: true, data: { status: 'already_reserved' } });
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();

  await expect(
    reserve(sessionStore, reserveRequest('qa-case', 'other-device')),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
});

test('another session and another store sharing the claim root are both refused', async () => {
  const { stateDir } = setup();
  const first = store(stateDir, 'first-sessions');
  const second = store(stateDir, 'second-sessions');
  mockResolveTargetDevice.mockResolvedValue(DEVICE);
  await reserve(first, reserveRequest('first'));

  const sameDaemon = await reserve(first, reserveRequest('second'));
  expect(sameDaemon).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });

  const otherStore = await reserve(second, reserveRequest('other-store'));
  expect(otherStore).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
  expect(inspectTestDeviceClaims({})).toHaveLength(1);
});

test('cancellation before publication releases the newly acquired claim', async () => {
  const { stateDir } = setup();
  const sessionStore = store(stateDir);
  mockResolveTargetDevice.mockResolvedValue(DEVICE);

  await expect(
    reserve(sessionStore, reserveRequest(), {
      throwIfCanceled: () => {
        throw createRequestCanceledError();
      },
    }),
  ).rejects.toBeInstanceOf(AppError);
  expect(sessionStore.get('qa-case')).toBeUndefined();
  expect(inspectTestDeviceClaims({})).toEqual([]);
});

test('closing an unlaunched reservation releases only its claim', async () => {
  const { stateDir } = setup();
  const sessionStore = store(stateDir);
  mockResolveTargetDevice.mockResolvedValue(DEVICE);
  await reserve(sessionStore);
  const bindDevice = vi.fn();

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'qa-case',
      command: 'close',
      positionals: [],
      flags: {},
      meta: { sessionExplicit: true },
    },
    sessionName: 'qa-case',
    logPath: path.join(stateDir, 'close.log'),
    sessionStore,
    invoke: noopInvoke,
    bindDevice,
  });

  expect(response).toMatchObject({ ok: true, data: { session: 'qa-case' } });
  expect(bindDevice).not.toHaveBeenCalled();
  expect(sessionStore.get('qa-case')).toBeUndefined();
  expect(inspectTestDeviceClaims({})).toEqual([]);
});

test('open converts the same reservation without replacing its claim', async () => {
  const { stateDir } = setup();
  const sessionStore = store(stateDir);
  mockResolveTargetDevice.mockResolvedValue(DEVICE);
  mockResolveIosApp.mockResolvedValueOnce('ru.yandex.mobile.search');
  await reserve(sessionStore);
  const before = sessionStore.get('qa-case')?.deviceClaim;

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'qa-case',
      command: 'open',
      positionals: ['Search App'],
      flags: {},
      meta: { sessionExplicit: true },
    },
    sessionName: 'qa-case',
    logPath: path.join(stateDir, 'open.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toMatchObject({ ok: true, data: { session: 'qa-case' } });
  expect(sessionStore.get('qa-case')).toMatchObject({
    appBundleId: 'ru.yandex.mobile.search',
    deviceClaim: {
      deviceKey: before?.deviceKey,
      ownerToken: before?.ownerToken,
      claimRootId: before?.claimRootId,
      claimBindingId: before?.claimBindingId,
    },
  });
  expect(sessionStore.get('qa-case')?.deviceClaim?.reservationPhase).toBeUndefined();
  expect(inspectTestDeviceClaims({})).toHaveLength(1);
});

test('an ambiguous launch retains the claim and marks the session recovery-only', async () => {
  const { stateDir } = setup();
  const sessionStore = store(stateDir);
  mockResolveTargetDevice.mockResolvedValue(DEVICE);
  mockResolveIosApp.mockResolvedValueOnce('ru.yandex.mobile.search');
  await reserve(sessionStore);
  mockLifecycleDispatch.mockRejectedValueOnce(new Error('launch outcome unknown'));

  await expect(
    handleSessionCommands({
      req: {
        token: 't',
        session: 'qa-case',
        command: 'open',
        positionals: ['Search App'],
        flags: {},
        meta: { sessionExplicit: true },
      },
      sessionName: 'qa-case',
      logPath: path.join(stateDir, 'open-unknown.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  ).rejects.toThrow('launch outcome unknown');

  expect(sessionStore.get('qa-case')?.deviceClaim?.reservationPhase).toBe('opening');
  expect(inspectTestDeviceClaims({})).toHaveLength(1);
});
