// Copyright 2026 Yandex LLC. All rights reserved.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

function clientWithQuality(snapshotQuality: unknown, truncated = false) {
  const setup = createTransport(async () => ({
    ok: true,
    data: { nodes: [], truncated, snapshotQuality },
  }));
  return createAgentDeviceClient(setup.config, { transport: setup.transport });
}

test.each(['healthy', 'sparse'] as const)(
  'SDK preserves %s bridge quality with its own backend identity',
  async (state) => {
    const quality = { state, backend: 'simulator-ax-bridge' };
    const result = await clientWithQuality(quality).capture.snapshot();
    assert.deepEqual(result.snapshotQuality, quality);
  },
);

test('SDK preserves useful bounded bridge quality with truncation and does not synthesize missing quality', async () => {
  const quality = { state: 'healthy', backend: 'simulator-ax-bridge' };
  const result = await clientWithQuality(quality, true).capture.snapshot();
  assert.deepEqual(result.snapshotQuality, quality);
  assert.equal(result.truncated, true);
  assert.equal((await clientWithQuality(undefined).capture.snapshot()).snapshotQuality, undefined);
  assert.equal(
    (await clientWithQuality({ state: 'healthy', backend: 'unknown-provider' }).capture.snapshot())
      .snapshotQuality,
    undefined,
  );
});
