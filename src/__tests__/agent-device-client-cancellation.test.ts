import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import {
  createAgentDeviceClient,
  type AgentDeviceDaemonTransport,
  type AgentDeviceDaemonTransportContext,
} from '../agent-device-client.ts';

test('a pre-aborted public request reaches no transport effect', async () => {
  let transportCalls = 0;
  const transport: AgentDeviceDaemonTransport = async () => {
    transportCalls += 1;
    return { ok: true, data: { devices: [] } };
  };
  const client = createAgentDeviceClient({}, { transport });
  const cancellation = new AbortController();
  cancellation.abort();

  await assert.rejects(
    client.devices.list({
      platform: 'ios',
      target: 'mobile',
      signal: cancellation.signal,
    }),
    isRequestCanceledError,
  );
  assert.equal(transportCalls, 0);
});

test('request cancellation is carried only in the transport context', async () => {
  let observedContext: AgentDeviceDaemonTransportContext | undefined;
  let observedRequest: Parameters<AgentDeviceDaemonTransport>[0] | undefined;
  const transport: AgentDeviceDaemonTransport = async (request, context) => {
    observedRequest = request;
    observedContext = context;
    return { ok: true, data: { devices: [] } };
  };
  const client = createAgentDeviceClient({}, { transport });
  const cancellation = new AbortController();

  await client.devices.list({
    platform: 'ios',
    target: 'mobile',
    signal: cancellation.signal,
  });

  assert.equal(observedContext?.signal, cancellation.signal);
  assert.equal(observedContext?.daemonBaseUrlPolicy, null);
  assert.equal(Object.hasOwn(observedRequest?.flags ?? {}, 'signal'), false);
  assert.equal(Object.hasOwn(observedRequest?.meta ?? {}, 'signal'), false);
});
