import { createHash } from 'node:crypto';
import { normalizeRef } from '@agent-device/kernel/snapshot';

export type InteractionTargetFingerprintInput =
  | Readonly<{ ref: string }>
  | Readonly<{ selector: string }>
  | Readonly<{ x: number; y: number }>;

/** Content-free correlation for a requested interaction target. */
export function interactionTargetFingerprint(target: InteractionTargetFingerprintInput): string {
  const identity =
    'ref' in target
      ? ['ref', requireRef(target.ref)]
      : 'selector' in target
        ? ['selector', target.selector]
        : ['point', requireCoordinate(target.x), requireCoordinate(target.y)];
  return `sha256-v1:${createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex')}`;
}

function requireRef(value: string): string {
  const normalized = normalizeRef(value);
  if (normalized === null) throw new TypeError('interaction target ref is invalid');
  return normalized;
}

function requireCoordinate(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('interaction target coordinate must be finite');
  return Object.is(value, -0) ? 0 : value;
}
