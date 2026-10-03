import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import { createAgentDeviceClient } from '../agent-device-client.ts';

test('screenshotArtifact returns bytes and removes its client-owned daemon output', async () => {
  const requests: unknown[] = [];
  let artifactRoot = '';
  const transport: AgentDeviceDaemonTransport = async (request) => {
    requests.push(request);
    const screenshot = request.positionals?.[0];
    assert.equal(typeof screenshot, 'string');
    artifactRoot = path.dirname(screenshot!);
    await fs.writeFile(screenshot!, new Uint8Array([1, 2, 3]), { mode: 0o600 });
    return { ok: true, data: { path: screenshot, width: 1, height: 1 } };
  };
  const client = createAgentDeviceClient({ session: 'qa' }, { transport });

  const result = await client.capture.screenshotArtifact({ overlayRefs: false });

  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.deepEqual(result.identifiers, { session: 'qa' });
  assert.equal(requests.length, 1);
  assert.equal(
    path.dirname((requests[0] as { positionals: string[] }).positionals[0]!),
    artifactRoot,
  );
  await assert.rejects(fs.access(artifactRoot));
});

test('screenshotArtifact rejects a remote daemon before transport dispatch', async () => {
  let calls = 0;
  const transport: AgentDeviceDaemonTransport = async () => {
    calls += 1;
    return { ok: true, data: {} };
  };
  const client = createAgentDeviceClient(
    { daemonBaseUrl: 'https://agent-device.example.test', session: 'qa' },
    { transport },
  );

  await assert.rejects(
    () => client.capture.screenshotArtifact(),
    /available only with a host-local agent-device daemon/,
  );
  assert.equal(calls, 0);
});
