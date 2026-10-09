// Copyright 2026 Yandex LLC. All rights reserved.

import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';

export const bridgeViewport = { x: 0, y: 0, width: 390, height: 844 };
export function bridgeAcquisition(): {
  stage: 'acquired';
  acquisition: SnapshotRuntimeAcquiredResult['acquisition'];
} {
  return {
    stage: 'acquired',
    acquisition: {
      producer: 'simulator-ax-bridge',
      intent: 'full',
      truncated: false,
      viewport: { kind: 'reported', rect: bridgeViewport },
      lineage: { generation: 'generation-1' },
      residue: [],
      nodes: [
        { index: 0, type: 'Window', label: 'Browser', rect: bridgeViewport },
        {
          index: 1,
          parentIndex: 0,
          type: 'Button',
          label: 'Dismiss',
          rect: { x: 20, y: 20, width: 100, height: 40 },
          hittable: true,
        },
      ],
    },
  };
}
