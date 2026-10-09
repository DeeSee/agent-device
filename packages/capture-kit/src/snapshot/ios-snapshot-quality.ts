// Copyright 2026 Yandex LLC. All rights reserved.

import type {
  IosAcquisitionResidue,
  IosSnapshotPublication,
  IosSnapshotRequest,
} from '@agent-device/contracts/ios-snapshot';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type { RawSnapshotNode, Rect, SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';

const STRUCTURAL_TYPES = new Set(['Application', 'Window', 'Other', 'ScrollView']);
const SPARSE_TRUNCATED_NODE_THRESHOLD = 8;

export function bridgeSnapshotQuality(
  acquisition: SnapshotRuntimeAcquiredResult['acquisition'],
  publication: IosSnapshotPublication,
  request: IosSnapshotRequest,
): SnapshotQualityVerdict | undefined {
  if (!hasBridgeQualityEvidence(acquisition)) return undefined;
  const nodes = publication.qualityNodes ?? publication.payload.nodes;
  const backend = 'simulator-ax-bridge' as const;
  if (nodes.length === 0) return { state: 'sparse', backend, reasonCode: 'no-nodes' };
  // An authored raw frontier can contain only shells; that cut is disclosed by truncation,
  // while regular depth and scope use the uncut quality projection from the full acquisition.
  if (request.projection === 'raw' && request.depth !== null && acquisition.truncated === true) {
    return { state: 'healthy', backend };
  }
  if (nodes.every((node) => isStructuralShell(node, acquisition.viewport))) {
    return {
      state: 'sparse',
      backend,
      reasonCode: 'sparse-tree',
      reason: 'snapshot returned no semantic controls or content',
    };
  }
  if (acquisition.truncated === true && nodes.length <= SPARSE_TRUNCATED_NODE_THRESHOLD) {
    return {
      state: 'sparse',
      backend,
      reasonCode: 'budget',
      reason: 'snapshot was cut off by its budget with almost nothing collected',
    };
  }
  return { state: 'healthy', backend };
}

function hasBridgeQualityEvidence(
  acquisition: SnapshotRuntimeAcquiredResult['acquisition'],
): boolean {
  if (acquisition.producer !== 'simulator-ax-bridge') return false;
  if (acquisition.viewport.kind !== 'reported' || typeof acquisition.truncated !== 'boolean')
    return false;
  if (!acquisition.lineage.generation || acquisition.residue.some(isQualityGap)) return false;
  return true;
}

function isQualityGap(residue: IosAcquisitionResidue): boolean {
  return residue.kind === 'unavailable-fact'
    ? residue.fact !== 'interactive-query'
    : residue.kind !== 'truncated';
}

function isStructuralShell(
  node: RawSnapshotNode,
  viewport: SnapshotRuntimeAcquiredResult['acquisition']['viewport'],
): boolean {
  if (!STRUCTURAL_TYPES.has(node.type ?? '')) return false;
  if (node.type === 'Application' || node.type === 'Window') return true;
  return (
    !semanticText(node.label) &&
    !semanticText(node.value) &&
    !hasAddressableIdentifier(node, viewport)
  );
}

function hasAddressableIdentifier(
  node: RawSnapshotNode,
  viewport: SnapshotRuntimeAcquiredResult['acquisition']['viewport'],
): boolean {
  if (typeof node.identifier !== 'string' || node.identifier.length === 0) return false;
  return (
    node.hittable === true || viewport.kind !== 'reported' || !equalRect(node.rect, viewport.rect)
  );
}

function equalRect(rect: Rect | undefined, other: Rect): boolean {
  return (
    !!rect &&
    rect.x === other.x &&
    rect.y === other.y &&
    rect.width === other.width &&
    rect.height === other.height
  );
}

function semanticText(value: string | undefined): boolean {
  const text = value?.trim();
  return !!text && text.toLowerCase() !== '[object object]';
}
