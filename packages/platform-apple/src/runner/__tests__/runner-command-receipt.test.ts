import {
  makeRunnerSession as makeSession,
  unwrittenConnectRefusal,
} from './runner-session-fixtures.ts';
import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import type { RunnerSession } from '../runner-session-types.ts';

const mocks = vi.hoisted(() => ({
  ensureSession: vi.fn(),
  executeWithSession: vi.fn(),
  getSnapshot: vi.fn(),
  invalidateSession: vi.fn(),
}));

vi.mock('../runner-session.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-session.ts')>('../runner-session.ts');
  return {
    ...actual,
    ensureRunnerSession: mocks.ensureSession,
    executeRunnerCommandWithSession: mocks.executeWithSession,
    readRunnerSessionLiveness: mocks.getSnapshot,
    invalidateRunnerSession: mocks.invalidateSession,
  };
});

import { prewarmIosRunnerSession, runAppleRunnerCommandWithReceipt } from '../runner-client.ts';
import { resetRunnerRecycleLedgerForTests } from '../runner-recycle-ledger.ts';

beforeEach(() => {
  vi.resetAllMocks();
  resetRunnerRecycleLedgerForTests();
  mocks.getSnapshot.mockReturnValue(null);
});

test('prewarm proves cached runner health with an uptime command', async () => {
  const session = makeSession({ port: 8100 });
  mocks.ensureSession.mockResolvedValueOnce(session);
  mocks.executeWithSession.mockResolvedValueOnce({ uptimeMs: 42 });

  await prewarmIosRunnerSession(IOS_SIMULATOR, {
    buildTimeoutMs: 300_000,
    requestId: 'prewarm-request',
  });

  assert.equal(mocks.ensureSession.mock.calls[0]?.[1]?.buildTimeoutMs, 300_000);
  assert.equal(mocks.ensureSession.mock.calls[0]?.[1]?.requestId, 'prewarm-request');
  assert.equal(mocks.ensureSession.mock.calls[0]?.[1]?.healthTimeoutMs, 45_000);
  assert.equal(mocks.executeWithSession.mock.calls[0]?.[2].command, 'uptime');
  assert.equal(mocks.executeWithSession.mock.calls[0]?.[4], 45_000);
});

test('receipt identifies the exact session that produced the runner response', async () => {
  const session = makeSession({ port: 8123 });
  mocks.ensureSession.mockResolvedValue(session);
  mocks.executeWithSession.mockResolvedValue({ message: 'tmp/screenshot.png' });

  const execution = await runAppleRunnerCommandWithReceipt(
    IOS_SIMULATOR,
    { command: 'screenshot' },
    {},
  );

  assert.deepEqual(execution.data, { message: 'tmp/screenshot.png' });
  assert.deepEqual(execution.receipt, receipt(session));
});

test('receipt follows the replacement session after pre-send recovery', async () => {
  const stale = makeSession({ port: 8100, state: 'ready' });
  const fresh = makeSession({ port: 8101, state: 'starting' });
  mocks.ensureSession.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
  mocks.executeWithSession
    .mockRejectedValueOnce(unwrittenConnectRefusal())
    .mockResolvedValueOnce({ message: 'tapped' });

  const execution = await runAppleRunnerCommandWithReceipt(IOS_SIMULATOR, {
    command: 'tap',
    x: 120,
    y: 240,
  });

  assert.deepEqual(execution.receipt, receipt(fresh));
});

test('exact attempted command uses same-session status recovery without invalidation', async () => {
  const session = makeSession({ port: 8100, state: 'ready' });
  mocks.ensureSession.mockResolvedValue(session);
  mocks.executeWithSession
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'fetch failed', {
        runnerCommandDispatch: 'attempted',
      }),
    )
    .mockResolvedValueOnce({
      lifecycleState: 'completed',
      lifecycleResponseJson: JSON.stringify({ ok: true, data: { recorderStartUptimeMs: 12 } }),
    });

  const execution = await runAppleRunnerCommandWithReceipt(
    IOS_SIMULATOR,
    { command: 'recordStart', outPath: 'capture.mp4' },
    {
      expectedRunnerSessionId: session.sessionId,
      expectedRunnerLaunchIdentity: session.launchIdentity,
    },
  );

  assert.deepEqual(execution.data, { recorderStartUptimeMs: 12 });
  assert.deepEqual(execution.receipt, receipt(session));
  assert.equal(mocks.invalidateSession.mock.calls.length, 0);
  assert.equal(mocks.ensureSession.mock.calls.length, 1);
});

function receipt(session: RunnerSession) {
  return { runnerSessionId: session.sessionId, launchIdentity: session.launchIdentity };
}
