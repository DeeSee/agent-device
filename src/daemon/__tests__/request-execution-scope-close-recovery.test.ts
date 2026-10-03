import { makeRequest } from './request-execution-scope.fixtures.ts';
import { test, expect } from 'vitest';

import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';

import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';

import {
  createRequestExecutionScope,
  prepareLockedRequestScope,
} from '../request-execution-scope.ts';

test('a session with unconfirmed teardown admits only an exact close retry', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  sessionStore.set('default', {
    ...makeIosSession('default'),
    closeRecovery: { state: 'retry-required' },
  });
  const snapshotScope = await createRequestExecutionScope({
    req: makeRequest({ command: 'snapshot' }),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
  });
  const blocked = await prepareLockedRequestScope({
    scope: snapshotScope,
    sessionStore,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  expect(blocked).toMatchObject({
    type: 'response',
    response: {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        details: { reason: 'session_close_retry_required', session: 'default' },
      },
    },
  });

  const closeScope = await createRequestExecutionScope({
    req: makeRequest({ command: 'close' }),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
  });
  expect(
    (
      await prepareLockedRequestScope({
        scope: closeScope,
        sessionStore,
        trackDownloadableArtifact: () => 'artifact-id',
      })
    ).type,
  ).toBe('scope');
});

test('a reservation with an unconfirmed first launch admits only close recovery', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  sessionStore.set('default', {
    ...makeIosSession('default'),
    deviceClaim: {
      deviceKey: 'apple:ios:simulator:sim-1',
      ownerToken: 'owner-token',
      ownerPid: process.pid,
      ownerStartTime: null,
      claimRootId: 'claim-root',
      claimBindingId: 'claim-binding',
      reservationPhase: 'opening',
    },
  });
  const snapshotScope = await createRequestExecutionScope({
    req: makeRequest({ command: 'snapshot' }),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
  });
  expect(
    await prepareLockedRequestScope({
      scope: snapshotScope,
      sessionStore,
      trackDownloadableArtifact: () => 'artifact-id',
    }),
  ).toMatchObject({
    type: 'response',
    response: {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        details: { reason: 'session_open_recovery_required', session: 'default' },
      },
    },
  });

  const closeScope = await createRequestExecutionScope({
    req: makeRequest({ command: 'close' }),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
  });
  expect(
    (
      await prepareLockedRequestScope({
        scope: closeScope,
        sessionStore,
        trackDownloadableArtifact: () => 'artifact-id',
      })
    ).type,
  ).toBe('scope');
});
