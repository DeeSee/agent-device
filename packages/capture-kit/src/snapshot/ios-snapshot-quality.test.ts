// Copyright 2026 Yandex LLC. All rights reserved.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createIosSnapshotRequest, deriveIosCaptureHint } from '../ios-snapshot-planning.ts';
import { publishIosSnapshot } from '../ios-snapshot-engine/engine.ts';
import type {
  SnapshotRuntimeAcquiredResult,
  SnapshotOptions,
} from '@agent-device/contracts/interactor-types';
import { bridgeSnapshotQuality } from './ios-snapshot-quality.ts';
import { bridgeAcquisition, bridgeViewport } from './ios-snapshot-quality.fixtures.ts';

function quality(input: SnapshotRuntimeAcquiredResult, options: SnapshotOptions = {}) {
  const request = createIosSnapshotRequest(options);
  const acquisition = {
    ...input.acquisition,
    intent: 'full' as const,
    hint: { ...deriveIosCaptureHint(request), acquisitionIntent: 'full' as const },
  };
  const publication = publishIosSnapshot({ stage: 'acquired', acquisition }, request);
  return bridgeSnapshotQuality(input.acquisition, publication, request);
}

test('an authored raw frontier stays healthy and disclosed as truncated', () => {
  const input = bridgeAcquisition();
  input.acquisition = {
    ...input.acquisition,
    nodes: input.acquisition.nodes.slice(0, 1),
    truncated: true,
    residue: [{ kind: 'truncated' }],
  };
  assert.equal(quality(input, { raw: true, depth: 0 })?.state, 'healthy');
});

test('an unexpected tiny acquisition cut remains sparse rather than healthy', () => {
  const input = bridgeAcquisition();
  input.acquisition = { ...input.acquisition, truncated: true, residue: [{ kind: 'truncated' }] };
  assert.equal(quality(input)?.state, 'sparse');
  assert.equal(quality(input)?.reasonCode, 'budget');
});

test('a useful bounded capture preserves healthy quality and its truncation disclosure', () => {
  const input = bridgeAcquisition();
  input.acquisition = {
    ...input.acquisition,
    truncated: true,
    residue: [{ kind: 'truncated' }],
    nodes: [
      input.acquisition.nodes[0]!,
      ...Array.from({ length: 9 }, (_, index) => ({
        index: index + 1,
        parentIndex: 0,
        type: 'Button',
        label: `Control ${index}`,
        rect: { x: 20, y: 20 + index * 50, width: 100, height: 40 },
        hittable: true,
      })),
    ],
  };
  assert.equal(quality(input)?.state, 'healthy');
  assert.equal(input.acquisition.truncated, true);
});

test('authored regular depth does not classify its root-only output as a sparse acquisition', () => {
  assert.equal(quality(bridgeAcquisition(), { depth: 0 })?.state, 'healthy');
});

test('offscreen raw controls do not make the presented shell healthy', () => {
  const input = bridgeAcquisition();
  input.acquisition = {
    ...input.acquisition,
    nodes: [
      input.acquisition.nodes[0]!,
      { ...input.acquisition.nodes[1]!, rect: { x: 400, y: 900, width: 100, height: 40 } },
    ],
  };
  assert.equal(quality(input)?.reasonCode, 'sparse-tree');
});

test('a fullscreen implementation identifier is not semantic content', () => {
  const input = bridgeAcquisition();
  input.acquisition = {
    ...input.acquisition,
    nodes: [
      input.acquisition.nodes[0]!,
      {
        index: 1,
        parentIndex: 0,
        type: 'Other',
        identifier: 'BrowserImplementationRoot',
        label: '[object Object]',
        rect: bridgeViewport,
        hittable: false,
      },
    ],
  };
  assert.equal(quality(input)?.reasonCode, 'sparse-tree');
});

test.each(['appium-source', 'limrun-ios-tree'] as const)(
  'other producer %s receives no synthetic bridge quality',
  (producer) => {
    const input = bridgeAcquisition();
    input.acquisition = { ...input.acquisition, producer };
    assert.equal(quality(input), undefined);
  },
);

test('unknown bridge viewport, generation, truncation or completeness stays unknown', () => {
  for (const patch of [
    { viewport: { kind: 'missing' as const, reason: 'not-provided' as const } },
    { lineage: {} },
    { truncated: undefined },
    { residue: [{ kind: 'unavailable-fact' as const, fact: 'acquisition-depth' as const }] },
  ]) {
    const input = bridgeAcquisition();
    input.acquisition = { ...input.acquisition, ...patch };
    assert.equal(quality(input, { raw: true }), undefined);
  }
});
