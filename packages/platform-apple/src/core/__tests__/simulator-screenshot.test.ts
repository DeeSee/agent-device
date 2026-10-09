// Copyright 2026 Yandex LLC. All rights reserved.

import { expect, test } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from '@agent-device/capture-kit/png';
import { runCmdStreaming, type ExecStreamOptions } from '@agent-device/host-kit/command';
import { captureSimulatorScreenshotAttempt } from '../simulator-screenshot.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

const image = PNG.sync.write(new PNG({ width: 2, height: 3 }));
const previousImage = PNG.sync.write(new PNG({ width: 3, height: 2 }));
const writeImageScript = `require('node:fs').writeFileSync(process.argv[1], Buffer.from('${image.toString('base64')}', 'base64'));`;

async function previousCapture(): Promise<string> {
  const outPath = path.join(await mkdtempForTest('agent-device-capture-completion-'), 'screen.png');
  await fs.writeFile(outPath, previousImage);
  return outPath;
}

test('a complete PNG followed by an ordinary nonzero exit stays a failure', async () => {
  const outPath = await previousCapture();
  const provider = createLocalAppleToolProvider({
    simctl: {
      run: async (args, options) =>
        await runCmdStreaming(
          process.execPath,
          ['-e', `${writeImageScript}setTimeout(() => process.exit(7), 20);`, String(args.at(-1))],
          options,
        ),
    },
  });
  await withAppleToolProvider(provider, async () => {
    await expect(
      captureSimulatorScreenshotAttempt(IOS_TEST_SIMULATOR, outPath, undefined, 500),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { exitCode: 7, processExitError: true },
    });
  });
  assert.deepEqual(await fs.readFile(outPath), previousImage);
});

test('a nonzero exit during our completion stop cannot become success', async () => {
  const outPath = await previousCapture();
  const provider = createLocalAppleToolProvider({
    simctl: {
      run: async (args, options) =>
        await runCmdStreaming(
          process.execPath,
          [
            '-e',
            `${writeImageScript}process.on('SIGINT', () => process.exit(7)); setInterval(() => {}, 1000);`,
            String(args.at(-1)),
          ],
          options,
        ),
    },
  });
  await withAppleToolProvider(provider, async () => {
    await expect(
      captureSimulatorScreenshotAttempt(IOS_TEST_SIMULATOR, outPath, undefined, 500),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { exitCode: 7, reason: 'simulator-screenshot-completion-failed' },
    });
  });
  assert.deepEqual(await fs.readFile(outPath), previousImage);
});

const badCrcImage = Buffer.from(image);
badCrcImage[badCrcImage.length - 1] = badCrcImage.readUInt8(badCrcImage.length - 1) ^ 1;
test.each([
  ['missing', undefined],
  ['malformed', Buffer.from('not a PNG')],
  ['partial', image.subarray(0, image.length - 8)],
  ['bad CRC', badCrcImage],
] as const)('zero exit with %s output preserves the previous capture', async (_name, bytes) => {
  const outPath = await previousCapture();
  const provider = createLocalAppleToolProvider({
    simctl: {
      run: async (args) => {
        assert.notEqual(args.at(-1), outPath);
        if (bytes) await fs.writeFile(String(args.at(-1)), bytes);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });
  await withAppleToolProvider(provider, async () => {
    await assert.rejects(
      captureSimulatorScreenshotAttempt(IOS_TEST_SIMULATOR, outPath, undefined, 500),
    );
  });
  assert.deepEqual(await fs.readFile(outPath), previousImage);
  assert.deepEqual(await fs.readdir(path.dirname(outPath)), ['screen.png']);
});

test('caller cancellation wins over a validated PNG and our successful SIGINT', async () => {
  const outPath = await previousCapture();
  const controller = new AbortController();
  const provider = createLocalAppleToolProvider({
    simctl: {
      run: async (args, options) =>
        await runCmdStreaming(
          process.execPath,
          ['-e', `${writeImageScript}setInterval(() => {}, 1000);`, String(args.at(-1))],
          {
            ...options,
            onSpawn: (child) => {
              (options as ExecStreamOptions)?.onSpawn?.(child);
              child.once('exit', () => controller.abort());
            },
          },
        ),
    },
  });
  await withAppleToolProvider(provider, async () => {
    await assert.rejects(
      captureSimulatorScreenshotAttempt(
        IOS_TEST_SIMULATOR,
        outPath,
        undefined,
        500,
        controller.signal,
      ),
      isRequestCanceledError,
    );
  });
  assert.deepEqual(await fs.readFile(outPath), previousImage);
});

test('an earlier host timeout cannot be reclassified as a completion stop', async () => {
  const outPath = await previousCapture();
  const script = `${writeImageScript}
    let interrupted = false;
    const exitWithSigint = () => { process.removeAllListeners('SIGINT'); process.kill(process.pid, 'SIGINT'); };
    process.on('SIGINT', () => { if (interrupted) exitWithSigint(); else { interrupted = true; setTimeout(exitWithSigint, 200); } });
    setInterval(() => {}, 1000);`;
  const provider = createLocalAppleToolProvider({
    simctl: {
      run: async (args, options) =>
        await runCmdStreaming(process.execPath, ['-e', script, String(args.at(-1))], options),
    },
  });
  await withAppleToolProvider(provider, async () => {
    await expect(
      captureSimulatorScreenshotAttempt(IOS_TEST_SIMULATOR, outPath, undefined, 100),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { timeoutMs: 100 } });
  });
  assert.deepEqual(await fs.readFile(outPath), previousImage);
});
