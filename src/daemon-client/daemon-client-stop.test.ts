import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { stopLocalDaemon, type StopLocalDaemonEffects } from './daemon-client-stop.ts';
import type { DaemonStopResult } from '../daemon-stop.ts';

const identity = {
  pid: 123,
  processStartTime: 'start-123',
  version: '0.20.10',
  codeSignature: 'graph:1:abc',
  deviceClaimRootId: 'claim-root',
};

function effects(overrides: Partial<StopLocalDaemonEffects> = {}): StopLocalDaemonEffects {
  const gracefulResult: DaemonStopResult = {
    stopped: true,
    mode: 'graceful',
    cleanupConfidence: 'unknown',
    claimsReleased: [],
    claimsOrphaned: [],
    claimsSuperseded: [],
    claimsUnattributable: [],
    providerReleases: { status: 'unknown', released: [], pending: null },
    warnings: [],
  };
  return {
    infoExists: () => true,
    readIdentity: () => identity,
    resolveClaimRootId: () => identity.deviceClaimRootId,
    stopProcess: vi.fn(async () => gracefulResult),
    readReport: () => ({
      schemaVersion: 2,
      daemon: identity,
      providerReleases: { released: [], pending: [] },
      claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
    }),
    ...overrides,
  };
}

const input = { stateDir: '/private/state', deviceClaimsDir: '/private/claims' };

test('a matching report with no pending authority proves complete cleanup', async () => {
  const result = await stopLocalDaemon(input, effects());

  assert.equal(result.kind, 'stopped');
  assert.equal(result.cleanup.kind, 'complete');
});

test('pending releases and orphaned claims produce typed incomplete cleanup', async () => {
  const result = await stopLocalDaemon(
    input,
    effects({
      readReport: () => ({
        schemaVersion: 2,
        daemon: identity,
        providerReleases: { released: [], pending: [{ leaseId: 'lease-1' }] },
        claims: {
          released: [],
          orphaned: [
            {
              deviceKey: 'ios:device-1',
              session: 'qa',
              platform: 'ios',
              deviceId: 'device-1',
            },
          ],
          superseded: [],
          unattributable: [],
        },
      }),
    }),
  );

  assert.equal(result.cleanup.kind, 'incomplete');
  if (result.cleanup.kind !== 'incomplete') return;
  assert.deepEqual(result.cleanup.reasons, ['provider_releases_pending', 'device_claims_orphaned']);
});

test('a stale report never proves cleanup', async () => {
  const result = await stopLocalDaemon(
    input,
    effects({
      readReport: () => ({
        schemaVersion: 2,
        daemon: { ...identity, processStartTime: 'older-start' },
        providerReleases: { released: [], pending: [] },
        claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
      }),
    }),
  );

  assert.deepEqual(result.cleanup, {
    kind: 'unknown',
    reason: 'shutdown_report_identity_mismatch',
  });
});

test('a graceful timeout performs no report read and remains retryable', async () => {
  const readReport = vi.fn(() => null);
  const timeoutResult: DaemonStopResult = {
    stopped: false,
    mode: 'grace-timeout',
    cleanupConfidence: 'unknown',
    claimsReleased: [],
    claimsOrphaned: [],
    claimsSuperseded: [],
    claimsUnattributable: [],
    providerReleases: { status: 'unknown', released: [], pending: null },
    warnings: [],
  };
  const result = await stopLocalDaemon(
    input,
    effects({
      stopProcess: vi.fn(async () => timeoutResult),
      readReport,
    }),
  );

  assert.equal(result.kind, 'still_running');
  assert.equal(readReport.mock.calls.length, 0);
});

test('claim-root mismatch is refused before the process effect', async () => {
  const stopProcess = vi.fn();
  await assert.rejects(
    stopLocalDaemon(input, effects({ resolveClaimRootId: () => 'another-root', stopProcess })),
    (error: { details?: { reason?: string } }) =>
      error.details?.reason === 'daemon_claim_root_mismatch',
  );
  assert.equal(stopProcess.mock.calls.length, 0);
});
