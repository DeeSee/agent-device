// Copyright 2026 Yandex LLC. All rights reserved.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { presentIosSnapshotAcquisition } from './ios-snapshot-runtime.ts';

import { bridgeAcquisition } from './ios-snapshot-quality.fixtures.ts';

test('a small complete simulator bridge frame publishes its own healthy quality', () => {
  const result = presentIosSnapshotAcquisition(bridgeAcquisition());
  assert.equal(result.nodes?.length, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.quality, { state: 'healthy', backend: 'simulator-ax-bridge' });
});

test('scoped output keeps whole-acquisition quality without publishing the private quality tree', () => {
  const result = presentIosSnapshotAcquisition(bridgeAcquisition(), { scope: 'Dismiss' });
  assert.equal(result.nodes?.length, 1);
  assert.equal(result.nodes?.[0]?.label, 'Dismiss');
  assert.deepEqual(result.quality, { state: 'healthy', backend: 'simulator-ax-bridge' });
  assert.equal('qualityNodes' in result, false);
});

test('scoping away the whole screen cannot turn an uncut sparse tree into healthy quality', () => {
  const input = bridgeAcquisition();
  input.acquisition = { ...input.acquisition, nodes: input.acquisition.nodes.slice(0, 1) };
  const result = presentIosSnapshotAcquisition(input, { scope: 'Dismiss' });
  assert.equal(result.nodes?.length, 0);
  assert.equal(result.quality?.state, 'sparse');
  assert.equal(result.quality?.reasonCode, 'sparse-tree');
});
