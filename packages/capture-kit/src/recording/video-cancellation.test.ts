import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';

const effects = vi.hoisted(() => ({
  compile: vi.fn(async () => '/private/video-validator'),
  run: vi.fn(async () => ({
    stdout: JSON.stringify({
      status: 'measured',
      source: 'media-pts',
      sampleCount: 1,
      mediaDurationMs: 0,
      firstPtsMs: 0,
      lastPtsMs: 0,
    }),
    stderr: '',
    exitCode: 0,
  })),
}));

vi.mock('./swift-cache.ts', () => ({
  buildSwiftToolEnv: () => ({}),
  compileSwiftSourceText: effects.compile,
}));
vi.mock('../../../host-kit/src/internal/exec.ts', () => ({ runCmd: effects.run }));

import { inspectVideo } from './video.ts';

const directory = mkdtempForTestSync('agent-device-video-cancellation-');

afterEach(() => {
  vi.clearAllMocks();
});

test('video inspection forwards the take signal to compilation and validation', async () => {
  const filePath = path.join(directory, 'capture.mp4');
  fs.writeFileSync(filePath, Buffer.concat([atom('ftyp'), atom('moov')]));
  const controller = new AbortController();

  await expect(inspectVideo(filePath, controller.signal)).resolves.toMatchObject({
    status: 'measured',
  });

  expect(effects.compile).toHaveBeenCalledWith(
    expect.objectContaining({ signal: controller.signal }),
  );
  expect(effects.run).toHaveBeenCalledWith(
    '/private/video-validator',
    [filePath],
    expect.objectContaining({ signal: controller.signal }),
  );
});

function atom(type: string): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(8, 0);
  bytes.write(type, 4, 4, 'latin1');
  return bytes;
}
