import { AppError } from '@agent-device/kernel/errors';
import { shellQuote, shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { sleep } from '@agent-device/host-kit/retry';
import type { DaemonTransportPreference } from '../daemon-resolution.ts';
import { resolveDaemonLockMutationGuardPath } from '../daemon-lock-mutation.ts';
import { resolveDaemonTakeover, type DaemonTakeoverDecision } from './daemon-launch-spec.ts';
import {
  type DaemonClientSettings,
  type EnsuredDaemon,
  refuseClaimRootMismatch,
} from './daemon-client-settings.ts';
import { startLocalDaemon, throwIfStartupCancelled } from './daemon-client-startup.ts';
import {
  cleanupStaleDaemonLockIfSafe,
  readDaemonInfo,
  stopDaemonMetadataOwnerForTakeover,
  type DaemonInfo,
} from './daemon-client-metadata.ts';
import {
  canConnect,
  cachedRemoteDaemonHealth,
  isDaemonTransportUnavailableError,
} from './daemon-client-transport.ts';

const LIVE_DAEMON_PROBE_RETRIES = 3;

const LIVE_DAEMON_PROBE_RETRY_DELAY_MS = 200;

export async function ensureDaemon(
  settings: DaemonClientSettings,
  signal?: AbortSignal,
): Promise<EnsuredDaemon> {
  throwIfStartupCancelled(signal);
  if (settings.remoteBaseUrl) {
    const remote = await ensureRemoteDaemon(settings);
    throwIfStartupCancelled(signal);
    return remote;
  }

  const ensured = await ensureLocalDaemon(settings, signal);
  // Checked on both branches: a startup can resolve to a daemon another caller raced in.
  await assertDaemonPolicyMatches(ensured.info, settings.paths.baseDir);
  return ensured;
}

async function ensureLocalDaemon(
  settings: DaemonClientSettings,
  signal?: AbortSignal,
): Promise<EnsuredDaemon> {
  const reusable = await readReusableLocalDaemon(settings);
  throwIfStartupCancelled(signal);
  if (reusable) return { info: reusable, startedByClient: false };

  if (!cleanupStaleDaemonLockIfSafe(settings.paths)) {
    const mutationGuardPath = resolveDaemonLockMutationGuardPath(settings.paths.lockPath);
    throw new AppError(
      'COMMAND_FAILED',
      'Refusing to start a second agent-device daemon while its lock owner is unverified',
      {
        reason: 'daemon_takeover_incomplete',
        phase: 'lock_preflight',
        lockPath: settings.paths.lockPath,
        mutationGuardPath,
        hint:
          `Keep the daemon lock and stop its exact PID/start-time owner with sufficient host ` +
          `permissions. If ${mutationGuardPath} is the only surviving authority, first confirm ` +
          `that no agent-device client or daemon is operating on this state directory, then ` +
          `remove only that empty guard directory with: rmdir ${shellQuote(mutationGuardPath)}. ` +
          `Then retry.`,
      },
    );
  }
  return await startLocalDaemon(settings, readReusableLocalDaemon, signal);
}

async function ensureRemoteDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  const remoteInfo: DaemonInfo = {
    transport: 'http',
    // Remote mode reuses the auth token as the daemon token so the existing JSON-RPC contract still works.
    token: settings.remoteAuthToken ?? '',
    pid: 0,
    baseUrl: settings.remoteBaseUrl,
  };
  const health = await cachedRemoteDaemonHealth(remoteInfo);
  if (health.reachable) {
    remoteInfo.remoteInstanceId = health.instanceId;
    remoteInfo.remoteUpstreamInstanceId = health.upstream?.instanceId;
    return { info: remoteInfo, startedByClient: false };
  }
  throw new AppError('COMMAND_FAILED', 'Remote daemon is unavailable', {
    daemonBaseUrl: settings.remoteBaseUrl,
    hint: 'Verify AGENT_DEVICE_DAEMON_BASE_URL points to a reachable daemon with GET /health and POST /rpc. If this CLI was connected with connect proxy, run agent-device disconnect to return to the local daemon.',
  });
}

async function readReusableLocalDaemon(settings: DaemonClientSettings): Promise<DaemonInfo | null> {
  const existing = readDaemonInfo(settings.paths.infoPath);
  if (!existing) return null;

  const decision = await resolveDaemonTakeover(existing, {
    onClientTransport: () => canReachReusableDaemon(existing, settings.transportPreference),
    onAnyAdvertisedTransport: () => canReachReusableDaemon(existing, 'auto'),
  });
  if (decision.kind === 'reuse') {
    refuseClaimRootMismatch(existing, true, settings);
    return existing;
  }
  if (decision.kind === 'refuseNewer') {
    throw newerDaemonRefusedError(existing, decision, settings.paths.baseDir);
  }

  emitDaemonTakeoverNotice(existing, decision.reason, settings.paths.baseDir);
  await stopDaemonMetadataOwnerForTakeover(settings.paths, existing);
  return null;
}

/**
 * A daemon whose pid is still alive is probed again before it can be judged unreachable. A probe's
 * budget is wall-clock time on this client's event loop, so a client that stalls past it (a large
 * synchronous parse, a GC pause on a loaded host) reads a listening daemon as unreachable, and
 * replacing it ends every session the daemon holds. Liveness is the signal-0 check, not the `ps`
 * identity read: under the load that stalls the probe, `ps` misses its deadline too, and the
 * takeover still proves identity before it signals anything.
 */
async function canReachReusableDaemon(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
): Promise<boolean> {
  if (await canConnectReusableDaemon(info, preference)) return true;
  for (let retry = 1; retry <= LIVE_DAEMON_PROBE_RETRIES; retry += 1) {
    if (!isProcessAlive(info.pid)) return false;
    await sleep(LIVE_DAEMON_PROBE_RETRY_DELAY_MS);
    if (await canConnectReusableDaemon(info, preference)) {
      emitDiagnostic({
        level: 'warn',
        phase: 'daemon_probe_recovered',
        data: { pid: info.pid, retry },
      });
      return true;
    }
  }
  return false;
}

/**
 * ADR 0029: a caller that names a daemon policy must not silently use a daemon that enforces a
 * different one (or none). A caller that names no policy uses whatever the daemon enforces.
 */
async function assertDaemonPolicyMatches(existing: DaemonInfo, stateDir: string): Promise<void> {
  if (!process.env.AGENT_DEVICE_DAEMON_POLICY?.trim()) return;
  const { loadDaemonPolicy } = await import('../daemon-policy-file.ts');
  const expected = loadDaemonPolicy(process.env)?.digest;
  if (expected === existing.policyDigest) return;
  throw new AppError(
    'COMMAND_FAILED',
    'The running daemon does not enforce the daemon policy named by AGENT_DEVICE_DAEMON_POLICY.',
    {
      reason: 'DAEMON_POLICY_MISMATCH',
      expectedPolicyDigest: expected,
      daemonPolicyDigest: existing.policyDigest ?? null,
      hint: `Stop the running daemon (agent-device daemon stop --state-dir ${shellQuoteIfNeeded(stateDir)}), then retry so a daemon starts with this policy.`,
    },
  );
}

async function canConnectReusableDaemon(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
): Promise<boolean> {
  try {
    return await canConnect(info, preference);
  } catch (error) {
    if (isDaemonTransportUnavailableError(error)) return false;
    throw error;
  }
}

function newerDaemonRefusedError(
  info: DaemonInfo,
  decision: Extract<DaemonTakeoverDecision, { kind: 'refuseNewer' }>,
  stateDir: string,
): AppError {
  const { daemonVersion, clientVersion } = decision;
  return new AppError(
    'COMMAND_FAILED',
    `Daemon (pid ${info.pid}, v${daemonVersion}) is newer than this client (v${clientVersion}); refusing to replace it.`,
    {
      daemonPid: info.pid,
      daemonVersion,
      clientVersion,
      hint: `Use the agent-device v${daemonVersion} CLI that started it, or stop it deliberately: agent-device daemon stop --state-dir ${shellQuoteIfNeeded(stateDir)}`,
    },
  );
}

function emitDaemonTakeoverNotice(info: DaemonInfo, reason: string, stateDir: string): void {
  try {
    const identity = info.version ? `pid ${info.pid}, v${info.version}` : `pid ${info.pid}`;
    process.stderr.write(`Replacing daemon (${identity}) in ${stateDir}: ${reason}\n`);
  } catch {
    // The takeover notice is best effort; never fail the command on stderr issues.
  }
}
