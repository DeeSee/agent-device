import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

import { afterEach, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { resolveDaemonPaths, type DaemonPaths } from '../../daemon-resolution.ts';
import { sendToDaemon } from '../daemon-client.ts';

import { listenOnLoopback } from '../../__tests__/test-utils/loopback.ts';
import {
  type HttpDaemonFixture,
  currentDaemonCodeSignature,
} from '../../__tests__/test-utils/daemon-http-fixture.ts';

import { runCmdDetachedMonitored, runCmdSync } from '@agent-device/host-kit/command';

import { sleep } from '@agent-device/host-kit/retry';
import { readVersion } from '@agent-device/host-kit/version';
vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetached: vi.fn(),
  runCmdDetachedMonitored: vi.fn(),
  runCmdSync: vi.fn(() => ({ exitCode: 1, stdout: '', stderr: '' })),
}));

vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return {
    ...actual,
    readProcessStartTime: (pid: number) =>
      pid === 999_997 ? `fixture-start-${pid}` : actual.readProcessStartTime(pid),
  };
});

vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(async () => {}),
}));

type DaemonInfoFixture = {
  port?: number;
  httpPort?: number;
  transport: 'socket' | 'http' | 'dual';
  token?: string;
  pid?: number;
  version?: string;
  codeSignature?: string;
  processStartTime?: string;
};

const mockRunCmdDetached = vi.mocked(runCmdDetachedMonitored);

const mockRunCmdSync = vi.mocked(runCmdSync);

const mockSleep = vi.mocked(sleep);

const FIXTURE_DAEMON_PID = 999_997;

function fixtureProcessStartTime(pid: number): string {
  return `fixture-start-${pid}`;
}

afterEach(() => {
  mockRunCmdDetached.mockReset();
  mockRunCmdSync.mockClear();
  mockSleep.mockClear();
  vi.unstubAllEnvs();
});

function makeTempStateDir(prefix: string): string {
  return mkdtempForTestSync(prefix);
}

function writeDaemonInfo(paths: DaemonPaths, info: DaemonInfoFixture): void {
  const pid = info.pid ?? FIXTURE_DAEMON_PID;
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    `${JSON.stringify({
      token: info.token ?? 'local-secret',
      pid,
      version: info.version ?? readVersion(),
      codeSignature: info.codeSignature ?? currentDaemonCodeSignature(),
      processStartTime: info.processStartTime ?? fixtureProcessStartTime(pid),
      port: info.port,
      httpPort: info.httpPort,
      transport: info.transport,
    })}\n`,
    'utf8',
  );
}

function writeDaemonLock(
  paths: DaemonPaths,
  lock: { pid: number; processStartTime?: string; startedAt?: number },
): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.lockPath,
    `${JSON.stringify({
      startedAt: Date.now(),
      ...lock,
      processStartTime: lock.processStartTime ?? fixtureProcessStartTime(lock.pid),
    })}\n`,
    'utf8',
  );
}

async function startHttpDaemonErrorFixture(
  errorResult: Record<string, unknown>,
): Promise<HttpDaemonFixture> {
  const seenPaths: string[] = [];
  const rpcRequests: Record<string, any>[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    seenPaths.push(`${req.method ?? 'GET'} ${url.pathname}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        const rpcRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          any
        >;
        rpcRequests.push(rpcRequest);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpcRequest.id,
            result: { ok: false, error: errorResult },
          }),
        );
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
  const port = await listenOnLoopback(server);
  return { server, port, seenPaths, rpcRequests };
}

function installSpawnedHttpDaemonAtOwnedStateDir(
  httpPort: number,
  onStateDir: (stateDir: string) => void,
): void {
  mockRunCmdDetached.mockImplementation((_command, _args, options) => {
    const ownedStateDir = String(options?.env?.AGENT_DEVICE_STATE_DIR);
    onStateDir(ownedStateDir);
    const ownedPaths = resolveDaemonPaths(ownedStateDir);
    writeDaemonLock(ownedPaths, {
      pid: FIXTURE_DAEMON_PID,
    });
    writeDaemonInfo(ownedPaths, { httpPort, transport: 'http' });
    return { pid: FIXTURE_DAEMON_PID, exited: new Promise(() => {}) };
  });
}

async function startHangingHttpDaemonFixture(): Promise<HttpDaemonFixture> {
  const seenPaths: string[] = [];
  const rpcRequests: Record<string, any>[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    seenPaths.push(`${req.method ?? 'GET'} ${url.pathname}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        rpcRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>);
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
  const port = await listenOnLoopback(server);
  return { server, port, seenPaths, rpcRequests };
}

function installSpawnedHttpDaemon(paths: DaemonPaths, httpPort: number): void {
  mockRunCmdDetached.mockImplementation((_command, _args, options) => {
    assert.equal(options?.env?.AGENT_DEVICE_STATE_DIR, paths.baseDir);
    writeDaemonLock(paths, {
      pid: FIXTURE_DAEMON_PID,
    });
    writeDaemonInfo(paths, { httpPort, transport: 'http' });
    return { pid: FIXTURE_DAEMON_PID, exited: new Promise(() => {}) };
  });
}

function mockSocketConnectionFailures(failingPort: number): {
  ports: number[];
  restore: () => void;
} {
  const ports: number[] = [];
  const originalCreateConnection = net.createConnection;
  (net as unknown as { createConnection: typeof net.createConnection }).createConnection = ((
    ...args: Parameters<typeof net.createConnection>
  ) => {
    const options = args[0] as { port?: number | string };
    if (Number(options.port) !== failingPort) {
      return originalCreateConnection(...args);
    }
    ports.push(Number(options.port));
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      end: () => void;
      setEncoding: (_encoding: string) => void;
      setTimeout: (_ms: number) => typeof socket;
      write: (_chunk: string) => boolean;
    };
    socket.destroy = () => {};
    socket.end = () => {
      socket.emit('close');
    };
    socket.setEncoding = () => {};
    socket.setTimeout = () => socket;
    socket.write = () => true;
    process.nextTick(() => {
      socket.emit('error', new Error('ECONNREFUSED'));
    });
    return socket as unknown as net.Socket;
  }) as typeof net.createConnection;

  return {
    ports,
    restore: () => {
      (net as unknown as { createConnection: typeof net.createConnection }).createConnection =
        originalCreateConnection;
    },
  };
}

function mockSocketErrorAfterWrite(failingPort: number): {
  ports: number[];
  writes: string[];
  restore: () => void;
} {
  const ports: number[] = [];
  const writes: string[] = [];
  const originalCreateConnection = net.createConnection;
  (net as unknown as { createConnection: typeof net.createConnection }).createConnection = ((
    ...args: Parameters<typeof net.createConnection>
  ) => {
    const options = args[0] as { port?: number | string };
    const connectListener = args[1] as (() => void) | undefined;
    if (Number(options.port) !== failingPort) {
      return originalCreateConnection(...args);
    }

    ports.push(Number(options.port));
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      end: () => void;
      setEncoding: (_encoding: string) => void;
      setTimeout: (_ms: number) => typeof socket;
      write: (_chunk: string) => boolean;
    };
    socket.destroy = () => {};
    socket.end = () => {
      socket.emit('close');
    };
    socket.setEncoding = () => {};
    socket.setTimeout = () => socket;
    socket.write = (chunk) => {
      writes.push(chunk);
      process.nextTick(() => {
        socket.emit('error', new Error('ECONNRESET after write'));
      });
      return true;
    };
    process.nextTick(() => connectListener?.());
    return socket as unknown as net.Socket;
  }) as typeof net.createConnection;

  return {
    ports,
    writes,
    restore: () => {
      (net as unknown as { createConnection: typeof net.createConnection }).createConnection =
        originalCreateConnection;
    },
  };
}

function heldDivergenceError(
  resume: Record<string, unknown> = { allowed: true, from: 3, planDigest: 'digest-abc' },
): Record<string, unknown> {
  return {
    code: 'REPLAY_DIVERGENCE',
    message: 'Replay failed at step 3 (click id="save"): selector-miss',
    details: {
      divergence: {
        version: 1,
        kind: 'selector-miss',
        resume: { ...resume, repairSessionHeld: true },
        repairHint: 'record-and-heal',
      },
    },
  };
}

function unheldDivergenceError(): Record<string, unknown> {
  return {
    code: 'REPLAY_DIVERGENCE',
    message: 'Replay failed at step 2 (click id="save"): selector-miss',
    details: {
      divergence: {
        version: 1,
        kind: 'selector-miss',
        resume: { allowed: true, from: 2, planDigest: 'digest-def' },
        repairHint: 'manual',
      },
    },
  };
}

function activeReplaySuccessData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    replayed: 1,
    healed: 0,
    session: 'default',
    sessionActive: true,
    artifactPaths: [],
    message: 'Replayed 1 step in 0.1s',
    ...overrides,
  };
}

async function replayLeavingSessionActive(
  daemonPort: number,
  requestId: string,
): Promise<{ response: Awaited<ReturnType<typeof sendToDaemon>>; ownedStateDir: string }> {
  let ownedStateDir = '';
  installSpawnedHttpDaemonAtOwnedStateDir(daemonPort, (dir) => {
    ownedStateDir = dir;
  });
  const response = await sendToDaemon({
    session: 'default',
    command: 'replay',
    positionals: ['open-only.ad'],
    flags: { daemonTransport: 'http' },
    meta: { requestId },
  });
  return { response, ownedStateDir };
}

function parseAddressHint(hint: string): { stateDir: string; session: string } {
  const match = hint.match(/--state-dir (\S+) --session (\S+)/);
  assert.ok(match, `hint did not contain a parseable --state-dir/--session pair: ${hint}`);
  return { stateDir: match[1] ?? '', session: match[2] ?? '' };
}
export const testFixture = {
  mockRunCmdDetached,
  mockRunCmdSync,
  mockSleep,
  FIXTURE_DAEMON_PID,
  fixtureProcessStartTime,
  makeTempStateDir,
  writeDaemonInfo,
  writeDaemonLock,
  startHttpDaemonErrorFixture,
  installSpawnedHttpDaemonAtOwnedStateDir,
  startHangingHttpDaemonFixture,
  installSpawnedHttpDaemon,
  mockSocketConnectionFailures,
  mockSocketErrorAfterWrite,
  heldDivergenceError,
  unheldDivergenceError,
  activeReplaySuccessData,
  replayLeavingSessionActive,
  parseAddressHint,
};
export type { DaemonInfoFixture };
