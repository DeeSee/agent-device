import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

const STATE_DIR = mkdtempForTestSync('agent-device-client-close-');

function clientReturning(response: DaemonResponse) {
  return createAgentDeviceClient(
    { session: 'qa', stateDir: STATE_DIR },
    { transport: async () => response },
  );
}

const SESSION_NOT_FOUND: DaemonResponse = {
  ok: false,
  error: { code: 'SESSION_NOT_FOUND', message: 'No active session' },
};

test('sessions.close reports whether it closed or found no session', async () => {
  const closed = await clientReturning({ ok: true, data: { session: 'qa' } }).sessions.close();
  const absent = await clientReturning(SESSION_NOT_FOUND).sessions.close();

  assert.equal(closed.disposition, 'closed');
  assert.equal(absent.disposition, 'already_absent');
  assert.deepEqual(absent.identifiers, { session: 'qa' });
});

test('missing sessions do not satisfy requested close effects or app close', async () => {
  const client = clientReturning(SESSION_NOT_FOUND);
  const operations = [
    () => client.sessions.close({ shutdown: true }),
    () => client.sessions.close({ saveScript: true }),
    () => client.apps.close(),
  ];

  for (const operation of operations) {
    await assert.rejects(
      operation,
      (error: unknown) => error instanceof AppError && error.code === 'SESSION_NOT_FOUND',
    );
  }
});
