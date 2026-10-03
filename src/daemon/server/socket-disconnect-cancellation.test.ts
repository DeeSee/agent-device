import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, vi } from 'vitest';

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly writes: string[] = [];

  setEncoding(): void {}

  write(value: string): void {
    this.writes.push(value);
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

class FakeServer {
  destroyConnections?: () => void;

  close(callback?: () => void): void {
    callback?.();
  }
}

const fixture = vi.hoisted(() => ({
  accept: undefined as ((socket: FakeSocket) => void) | undefined,
}));

vi.mock('node:net', () => ({
  default: {
    createServer: (accept: (socket: FakeSocket) => void) => {
      fixture.accept = accept;
      return new FakeServer();
    },
  },
}));

import { createSocketServer } from './transport.ts';
import { getRequestSignal } from '@agent-device/host-kit/request';

test('a disconnect latched before request registration cancels later buffered work', async () => {
  let handlerCalls = 0;
  createSocketServer(async () => {
    handlerCalls += 1;
    return { ok: true, data: {} };
  });
  assert.ok(fixture.accept);
  const socket = new FakeSocket();
  fixture.accept(socket);

  socket.emit('close');
  socket.emit(
    'data',
    `${JSON.stringify({
      token: 'test-token',
      session: 'socket-disconnect',
      command: 'devices',
      positionals: [],
      flags: {},
      meta: { requestId: 'socket-disconnect-late-registration' },
    })}\n`,
  );
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(handlerCalls, 0);
});

test('disconnect cancellation is isolated to requests from that socket', async () => {
  const signals = new Map<string, AbortSignal | undefined>();
  const finish = new Map<string, () => void>();
  createSocketServer(
    async (request) =>
      await new Promise((resolve) => {
        const requestId = request.meta?.requestId ?? '';
        signals.set(requestId, getRequestSignal(requestId));
        finish.set(requestId, () => resolve({ ok: true, data: {} }));
      }),
  );
  assert.ok(fixture.accept);
  const first = new FakeSocket();
  const second = new FakeSocket();
  fixture.accept(first);
  fixture.accept(second);

  first.emit('data', `${requestLine('request-a')}\n`);
  second.emit('data', `${requestLine('request-b')}\n`);
  await Promise.resolve();
  assert.equal(signals.get('request-a')?.aborted, false);
  assert.equal(signals.get('request-b')?.aborted, false);

  first.emit('close');

  assert.equal(signals.get('request-a')?.aborted, true);
  assert.equal(signals.get('request-b')?.aborted, false);
  finish.get('request-a')?.();
  finish.get('request-b')?.();
  await Promise.resolve();
});

function requestLine(requestId: string): string {
  return JSON.stringify({
    token: 'test-token',
    session: 'socket-disconnect',
    command: 'devices',
    positionals: [],
    flags: {},
    meta: { requestId },
  });
}
