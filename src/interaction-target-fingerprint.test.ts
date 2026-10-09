import { expect, test } from 'vitest';
import { interactionTargetFingerprint } from './interaction-target-fingerprint.ts';

test('fingerprints normalize ref spelling and preserve the published correlation format', () => {
  const expected = 'sha256-v1:1b3490b7fc04700376706580cefef496699ba754d59297a6ca844aa528b4553c';
  expect(interactionTargetFingerprint({ ref: '@e001' })).toBe(expected);
  expect(interactionTargetFingerprint({ ref: ' e001~s3 ' })).toBe(expected);
  expect(interactionTargetFingerprint({ selector: 'id=x' })).toBe(
    'sha256-v1:35876ba6d32b8255dc10412efcf9ff97c2134f9cbcf357e4987f6c75b93549e6',
  );
  expect(interactionTargetFingerprint({ x: 1, y: 2 })).toBe(
    'sha256-v1:6bf657dd8a1f74d09b1282b2f92f50ae9b6b0fc17a2f3c39c69dd2f7f2284df5',
  );
});

test('fingerprints reject malformed refs and nonfinite points', () => {
  expect(() => interactionTargetFingerprint({ ref: '@' })).toThrow(TypeError);
  expect(() => interactionTargetFingerprint({ x: Number.NaN, y: 0 })).toThrow(TypeError);
  expect(interactionTargetFingerprint({ x: -0, y: 0 })).toBe(
    interactionTargetFingerprint({ x: 0, y: 0 }),
  );
});
