import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempForTest } from '../__tests__/test-utils/tmp-dir.ts';
import path from 'node:path';
import { test } from 'vitest';
import { captureLocalScreenshotArtifact } from './local-screenshot-artifact.ts';

test('uses one private output and removes its complete namespace', async () => {
  let root = '';
  const capture = await captureLocalScreenshotArtifact(async (outputPath) => {
    root = path.dirname(outputPath);
    await fs.writeFile(outputPath, new Uint8Array([1, 2, 3]), { mode: 0o600 });
    return 'receipt';
  });

  assert.equal(capture.result, 'receipt');
  assert.deepEqual([...capture.bytes], [1, 2, 3]);
  await assert.rejects(fs.access(root));
});

test('refuses a symlink without reading its target and still removes the namespace', async () => {
  const targetRoot = await mkdtempForTest('agent-device-target-');
  const target = path.join(targetRoot, 'private.png');
  let artifactRoot = '';
  try {
    await fs.writeFile(target, new Uint8Array([9, 8, 7]), { mode: 0o600 });
    await assert.rejects(
      captureLocalScreenshotArtifact(async (outputPath) => {
        artifactRoot = path.dirname(outputPath);
        await fs.symlink(target, outputPath);
      }),
      /could not be consumed safely/,
    );
    assert.deepEqual([...(await fs.readFile(target))], [9, 8, 7]);
    await assert.rejects(fs.access(artifactRoot));
  } finally {
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
});
