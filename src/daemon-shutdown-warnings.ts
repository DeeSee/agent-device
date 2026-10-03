import type { DaemonStopResult } from './daemon-stop.ts';

/** A superseded claim is not a failure to report as one, but the operator's
 * device is now owned elsewhere, so it must not pass silently. */
export function supersededClaimWarnings(
  superseded: DaemonStopResult['claimsSuperseded'],
): string[] {
  if (superseded.length === 0) return [];
  const devices = superseded.map((claim) => claim.deviceId).join(', ');
  return [
    `Another owner had already claimed ${devices} before this daemon released it, so those devices are now owned elsewhere.`,
  ];
}

/** An orphaned claim keeps holding its device after the daemon is gone, and
 * only `device release --stale` or the next open settles it — say so instead
 * of leaving the block discoverable through --json alone.
 *
 * A record whose owner could not be attributed is NOT reported here. Those are what
 * `--stale` hides and refuses, so this sentence would send the operator to a route that cannot
 * succeed; {@link unattributableClaimWarnings} names the view that does show them. */
export function orphanedClaimWarnings(orphaned: DaemonStopResult['claimsOrphaned']): string[] {
  if (orphaned.length === 0) return [];
  const devices = orphaned.map((claim) => claim.deviceId).join(', ');
  return [
    `Ownership of ${devices} was not released cleanly; the claim now blocks other owners until it is settled. Inspect with: agent-device device status --stale, then release with: agent-device device release --stale.`,
  ];
}

/**
 * What the three provable buckets each get an exact remedy for, this one does not: settling a claim
 * always rests on a proof about its owner, and this record names none. So the warning states only
 * what is known, points at the view that lists these records — the default one, because `--stale`
 * filters records without a decodable owner out — and does not promise a release that would clear
 * them. `device release --stale` refuses every record that names no owner, and the next `open` refuses
 * to overwrite one. The one principal that can clear an allocator-held record is the allocator that
 * issued it, which is named on the refusal rather than guessed at here.
 */
export function unattributableClaimWarnings(
  unattributable: DaemonStopResult['claimsUnattributable'],
): string[] {
  if (unattributable.length === 0) return [];
  const devices = unattributable.map((claim) => claim.deviceId).join(', ');
  return [
    `A claim for ${devices} remains whose owner could not be read, so this daemon cannot say whether those devices are free. ` +
      'No device release route settles it: --stale proves staleness from the recorded owner and refuses records that name none, ' +
      'and open refuses to overwrite them. Inspect with: agent-device device status.',
  ];
}
