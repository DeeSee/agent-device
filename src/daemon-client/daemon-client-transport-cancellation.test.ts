import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, vi } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly writes: string[] = [];

  setEncoding(): void {}
  setTimeout(): void {}
  write(value: string): void {
    this.writes.push(value);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeHttpRequest extends EventEmitter {
  destroyed = false;
  readonly writes: string[] = [];

  write(value: string): void {
    this.writes.push(value);
  }
  end(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

const fixture = vi.hoisted(() => ({
  socket: undefined as FakeSocket | undefined,
  connected: undefined as (() => void) | undefined,
  httpRequest: undefined as FakeHttpRequest | undefined,
}));

vi.mock('../../packages/host-kit/src/internal/transport.ts', () => ({
  loadNodeHttpRequester: async () => ({
    request: () => {
      const request = new FakeHttpRequest();
      fixture.httpRequest = request;
      return request;
    },
  }),
  readNodeHttpResponseBody: vi.fn(),
}));

vi.mock('node:net', () => ({
  default: {
    createConnection: (_options: unknown, connected: () => void) => {
      const socket = new FakeSocket();
      fixture.socket = socket;
      fixture.connected = connected;
      return socket;
    },
  },
}));

import { sendRequest } from './daemon-client-transport.ts';

test('mid-flight AbortSignal destroys only the request connection and rejects as canceled', async () => {
  const cancellation = new AbortController();
  const request = sendRequest(
    { port: 1234, token: 'token', pid: 123 },
    {
      token: 'token',
      session: 'qa',
      command: 'devices',
      positionals: [],
      flags: {},
      meta: { requestId: 'cancel-mid-flight' },
    },
    'socket',
    {
      baseDir: '/private/state',
      infoPath: '/private/state/daemon.json',
      lockPath: '/private/state/daemon.lock',
      logPath: '/private/state/daemon.log',
      sessionsDir: '/private/state/sessions',
      allocationsDir: '/private/state/allocations',
    },
    undefined,
    { signal: cancellation.signal },
  );
  assert.ok(fixture.connected);
  fixture.connected();
  assert.equal(fixture.socket?.writes.length, 1);

  cancellation.abort();

  await assert.rejects(request, isRequestCanceledError);
  assert.equal(fixture.socket?.destroyed, true);
});

test('mid-flight AbortSignal destroys an HTTP request and rejects as canceled', async () => {
  const cancellation = new AbortController();
  const request = sendRequest(
    { httpPort: 1234, token: 'token', pid: 123 },
    {
      token: 'token',
      session: 'qa',
      command: 'devices',
      positionals: [],
      flags: {},
      meta: { requestId: 'cancel-http-mid-flight' },
    },
    'http',
    {
      baseDir: '/private/state',
      infoPath: '/private/state/daemon.json',
      lockPath: '/private/state/daemon.lock',
      logPath: '/private/state/daemon.log',
      sessionsDir: '/private/state/sessions',
      allocationsDir: '/private/state/allocations',
    },
    undefined,
    { signal: cancellation.signal },
  );
  await Promise.resolve();
  assert.equal(fixture.httpRequest?.writes.length, 1);

  cancellation.abort();

  await assert.rejects(request, isRequestCanceledError);
  assert.equal(fixture.httpRequest?.destroyed, true);
});
