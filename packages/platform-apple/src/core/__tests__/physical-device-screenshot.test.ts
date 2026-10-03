import { RUNNER_LAUNCH_IDENTITY_FIXTURE } from '../../runner/__tests__/runner-identity-fixtures.ts';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { IOS_DEVICE } from '../../__tests__/device-fixtures.ts';
import {
  captureCoreDeviceScreenshot,
  shouldFallbackToRunnerForIosScreenshot,
} from '../physical-device-screenshot.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import { AppError } from '@agent-device/kernel/errors';

test('captureCoreDeviceScreenshot invokes devicectl with the current capture-screenshot syntax', async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];

  await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (cmd, args) => {
        calls.push({ cmd, args });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () =>
      await captureCoreDeviceScreenshot(IOS_DEVICE, '/tmp/out.png', {
        runRunnerCommandWithReceipt: async () => {
          throw new Error('devicectl capture should have succeeded without a runner fallback');
        },
      }),
  );

  assert.deepEqual(calls, [
    {
      cmd: 'xcrun',
      args: [
        'devicectl',
        'device',
        'capture',
        'screenshot',
        '--device',
        IOS_DEVICE.id,
        '--destination',
        '/tmp/out.png',
      ],
    },
  ]);
});

test('shouldFallbackToRunnerForIosScreenshot detects removed devicectl subcommand output', () => {
  const error = new AppError('COMMAND_FAILED', 'Failed to capture iOS screenshot', {
    stderr: "error: Unknown option '--device'",
  });
  assert.equal(shouldFallbackToRunnerForIosScreenshot(error), true);
});

test('shouldFallbackToRunnerForIosScreenshot ignores unrelated command failures', () => {
  const error = new AppError('COMMAND_FAILED', 'Failed to capture iOS screenshot', {
    stderr: 'error: device is busy connecting',
  });
  assert.equal(shouldFallbackToRunnerForIosScreenshot(error), false);
});

test('captureCoreDeviceScreenshot caches a recognized unsupported devicectl screenshot route', async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let runnerCalls = 0;
  await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (cmd, args) => {
        calls.push({ cmd, args });
        if (args.slice(0, 4).join(' ') === 'devicectl device capture screenshot') {
          return { exitCode: 64, stdout: '', stderr: "error: Unknown option '--device'" };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () => {
      const options = {
        runRunnerCommandWithReceipt: async () => {
          runnerCalls += 1;
          return {
            data: { message: 'tmp/runner-screenshot.png' },
            receipt: {
              runnerSessionId: 'fixture-session',
              launchIdentity: RUNNER_LAUNCH_IDENTITY_FIXTURE,
            },
          };
        },
      };
      await captureCoreDeviceScreenshot(IOS_DEVICE, '/tmp/first.png', options);
      await captureCoreDeviceScreenshot(IOS_DEVICE, '/tmp/second.png', options);
    },
  );
  assert.equal(
    calls.filter(({ args }) => args.slice(0, 4).join(' ') === 'devicectl device capture screenshot')
      .length,
    1,
  );
  assert.equal(runnerCalls, 2);
  assert.equal(
    calls.filter(({ args }) => args.slice(0, 4).join(' ') === 'devicectl device copy from').length,
    2,
  );
});
