import { expect, test } from 'vitest';
import { parseVideoInspectionOutput } from './video-inspection.ts';

test('parses measured cadence without substituting requested FPS', () => {
  expect(
    parseVideoInspectionOutput(
      JSON.stringify({
        status: 'measured',
        source: 'media-pts',
        sampleCount: 3,
        mediaDurationMs: 120,
        firstPtsMs: 10,
        lastPtsMs: 110,
        maxInterSampleGapMs: 60,
        effectiveFps: 20,
      }),
    ),
  ).toEqual({
    status: 'measured',
    source: 'media-pts',
    sampleCount: 3,
    mediaDurationMs: 120,
    firstPtsMs: 10,
    lastPtsMs: 110,
    maxInterSampleGapMs: 60,
    effectiveFps: 20,
  });
});

test.each([
  { sampleCount: 2, mediaDurationMs: 100, firstPtsMs: 0, lastPtsMs: 0 },
  { sampleCount: 2, mediaDurationMs: 100, firstPtsMs: 0, lastPtsMs: 100 },
  { sampleCount: 0, mediaDurationMs: 0, firstPtsMs: 0, lastPtsMs: 0 },
])('rejects incomplete or incoherent cadence payload %#', (payload) => {
  expect(
    parseVideoInspectionOutput(
      JSON.stringify({ status: 'measured', source: 'media-pts', ...payload }),
    ),
  ).toBeUndefined();
});
