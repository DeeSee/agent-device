import {
  IosSnapshotEngineError,
  publishIosSnapshot,
  toIosSnapshotEngineErrorDetails,
} from '../ios-snapshot-engine/index.ts';
import { createIosSnapshotRequest, deriveIosCaptureHint } from '../ios-snapshot-planning.ts';
import type {
  IosSnapshotPublication,
  IosSnapshotRequest,
  IosAcquisitionResidue,
  IosSnapshotFact,
  IosSnapshotInput,
} from '@agent-device/contracts/ios-snapshot';
import type {
  SnapshotOptions,
  SnapshotResult,
  SnapshotRuntimeAcquiredResult,
} from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode, Rect, SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';

const IOS_SNAPSHOT_FACT_WARNINGS: Partial<Record<IosSnapshotFact, string>> = {
  'acquisition-depth':
    'iOS snapshot acquisition does not report hierarchy completeness; provider-side depth or child limits may omit nodes.',
  hittability:
    'iOS snapshot acquisition does not provide hittability evidence; regular snapshots omit unverified hittability while raw snapshots preserve supplied facts.',
  truncation:
    'iOS snapshot acquisition does not expose truncation metadata; tree completeness is not independently verified.',
};

export function presentIosSnapshotAcquisition(
  acquired: SnapshotRuntimeAcquiredResult,
  options?: Readonly<Omit<SnapshotOptions, 'signal'>>,
): SnapshotResult {
  const request = createIosSnapshotRequest({
    raw: options?.raw,
    interactiveOnly: options?.interactiveOnly,
    depth: options?.depth,
    scope: options?.scope,
    customActions: options?.customActions,
    acquisitionIntent: acquired.acquisition.intent,
  });
  const input = iosSnapshotInput(acquired, request);

  try {
    const presentation = publishIosSnapshot(input, request);
    const quality = bridgeSnapshotQuality(acquired.acquisition, presentation, request);
    return {
      backend: 'xctest',
      producer: acquired.acquisition.producer,
      ...(quality ? { quality } : {}),
      nodes: [...presentation.payload.nodes],
      comparisonIdentity: presentation.comparisonIdentity,
      ...(acquired.acquisition.truncated === undefined
        ? {}
        : { truncated: acquired.acquisition.truncated }),
      ...snapshotWarnings(acquired.acquisition.residue),
    };
  } catch (error) {
    throwIosSnapshotPresentationError(error);
  }
}

function iosSnapshotInput(
  acquired: SnapshotRuntimeAcquiredResult,
  request: ReturnType<typeof createIosSnapshotRequest>,
): IosSnapshotInput {
  const hint = deriveIosCaptureHint(request);
  if (acquired.acquisition.intent === 'full') {
    return {
      stage: 'acquired',
      acquisition: {
        ...acquired.acquisition,
        intent: 'full',
        hint: { ...hint, acquisitionIntent: 'full' },
      },
    };
  }
  return {
    stage: 'acquired',
    acquisition: {
      ...acquired.acquisition,
      intent: 'surface-observation',
      hint: { ...hint, acquisitionIntent: 'surface-observation' },
    },
  };
}

function snapshotWarnings(residue: readonly IosAcquisitionResidue[]): { warnings?: string[] } {
  const warnings = new Set(
    residue.flatMap((entry) => {
      if (entry.kind === 'missing-viewport') {
        return [
          `iOS snapshot acquisition did not provide a valid viewport (${entry.reason}); retry with --raw to inspect the acquired tree, while regular presentation requires viewport evidence.`,
        ];
      }
      if (entry.kind !== 'unavailable-fact') return [];
      const warning = IOS_SNAPSHOT_FACT_WARNINGS[entry.fact];
      return warning ? [warning] : [];
    }),
  );
  return warnings.size === 0 ? {} : { warnings: [...warnings] };
}

function throwIosSnapshotPresentationError(error: unknown): never {
  if (!(error instanceof IosSnapshotEngineError)) throw error;
  const details = toIosSnapshotEngineErrorDetails(error);
  const hint =
    error.reason === 'missing-viewport' || error.reason === 'invalid-viewport'
      ? 'Use snapshot --raw to inspect the acquired iOS tree; regular presentation requires valid viewport evidence.'
      : undefined;
  throw new AppError(
    'COMMAND_FAILED',
    error.message,
    { ...details, ...(hint ? { hint } : {}) },
    error,
  );
}

const STRUCTURAL_TYPES = new Set(['Application', 'Window', 'Other', 'ScrollView']);
const SPARSE_TRUNCATED_NODE_THRESHOLD = 8;

function bridgeSnapshotQuality(
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
  if (isAuthoredRawFrontier(request, acquisition)) {
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

function isAuthoredRawFrontier(
  request: IosSnapshotRequest,
  acquisition: SnapshotRuntimeAcquiredResult['acquisition'],
): boolean {
  return request.projection === 'raw' && request.depth !== null && acquisition.truncated === true;
}
