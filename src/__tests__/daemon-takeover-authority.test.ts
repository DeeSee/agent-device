import { AppError } from '@agent-device/kernel/errors';
import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { inspectAgentDeviceDaemonProcess, stopProcessForTakeover } from '../daemon-process.ts';

const hostProcess = vi.hoisted(() => ({
  isAlive: vi.fn(),
  readCommand: vi.fn(),
  readStartTime: vi.fn(),
}));

vi.mock('@agent-device/host-kit/process', async () => ({
  ...(await vi.importActual<typeof import('@agent-device/host-kit/process')>(
    '@agent-device/host-kit/process',
  )),
  isProcessAlive: hostProcess.isAlive,
  readProcessCommand: hostProcess.readCommand,
  readProcessStartTime: hostProcess.readStartTime,
}));

const options = {
  termTimeoutMs: 3_000,
  killTimeoutMs: 1_000,
  expectedStartTime: 'expected-start',
};

beforeEach(() => {
  vi.clearAllMocks();
});

test('refuses daemon takeover when the live owner cannot be signalled', async () => {
  const inspectDaemonProcess = vi.fn(() => 'match' as const);
  const trySignal = vi.fn(() => false);
  const waitForExit = vi.fn(async () => true);

  let thrown: unknown;
  try {
    await stopProcessForTakeover(41, options, {
      inspectDaemonProcess,
      trySignal,
      waitForExit,
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof AppError);
  assert.equal(thrown.code, 'COMMAND_FAILED');
  assert.equal(thrown.details?.reason, 'daemon_takeover_incomplete');
  assert.equal(thrown.details?.phase, 'term_signal');
  assert.deepEqual(trySignal.mock.calls, [[41, 'SIGTERM']]);
  assert.equal(waitForExit.mock.calls.length, 0);
});

test('refuses daemon takeover when the exact owner survives SIGKILL', async () => {
  const inspectDaemonProcess = vi.fn(() => 'match' as const);
  const trySignal = vi.fn(() => true);
  const waitForExit = vi.fn(async () => false);

  let thrown: unknown;
  try {
    await stopProcessForTakeover(42, options, {
      inspectDaemonProcess,
      trySignal,
      waitForExit,
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof AppError);
  assert.equal(thrown.code, 'COMMAND_FAILED');
  assert.equal(thrown.details?.reason, 'daemon_takeover_incomplete');
  assert.equal(thrown.details?.phase, 'kill_timeout');
  assert.deepEqual(trySignal.mock.calls, [
    [42, 'SIGTERM'],
    [42, 'SIGKILL'],
  ]);
  assert.deepEqual(waitForExit.mock.calls, [
    [42, 3_000, 'expected-start'],
    [42, 1_000, 'expected-start'],
  ]);
});

test('allows daemon takeover when the exact owner exits after SIGTERM', async () => {
  const inspectDaemonProcess = vi.fn(() => 'match' as const);
  const trySignal = vi.fn(() => true);
  const waitForExit = vi.fn(async () => true);

  await stopProcessForTakeover(43, options, {
    inspectDaemonProcess,
    trySignal,
    waitForExit,
  });

  assert.deepEqual(trySignal.mock.calls, [[43, 'SIGTERM']]);
  assert.deepEqual(waitForExit.mock.calls, [[43, 3_000, 'expected-start']]);
});

test('refuses daemon takeover when a live PID identity is unverifiable', async () => {
  const inspectDaemonProcess = vi.fn(() => 'unknown' as const);
  const trySignal = vi.fn(() => true);
  const waitForExit = vi.fn(async () => true);

  await assert.rejects(
    () =>
      stopProcessForTakeover(44, options, {
        inspectDaemonProcess,
        trySignal,
        waitForExit,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'daemon_takeover_incomplete');
      assert.equal(error.details?.phase, 'identity_verification');
      return true;
    },
  );

  assert.equal(trySignal.mock.calls.length, 0);
  assert.equal(waitForExit.mock.calls.length, 0);
});

test('refuses a live daemon takeover when persisted start identity is blank', async () => {
  hostProcess.isAlive.mockReturnValue(true);
  hostProcess.readStartTime.mockReturnValue('actual-start');
  hostProcess.readCommand.mockReturnValue('agent-device dist/src/daemon.js');

  assert.equal(inspectAgentDeviceDaemonProcess(46, '   '), 'unknown');
  assert.equal(hostProcess.readStartTime.mock.calls.length, 0);
  assert.equal(hostProcess.readCommand.mock.calls.length, 0);
});

test('does not signal a proven different process at a recycled PID', async () => {
  const inspectDaemonProcess = vi.fn(() => 'different' as const);
  const trySignal = vi.fn(() => true);
  const waitForExit = vi.fn(async () => true);

  await stopProcessForTakeover(45, options, {
    inspectDaemonProcess,
    trySignal,
    waitForExit,
  });

  assert.equal(trySignal.mock.calls.length, 0);
  assert.equal(waitForExit.mock.calls.length, 0);
});
