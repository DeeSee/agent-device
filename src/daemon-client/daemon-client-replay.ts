import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import fs from 'node:fs';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { readReplayDivergenceResume } from '@agent-device/ad-replay/divergence';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DaemonWireRequest as DaemonRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { findUnrecoveredRepairCommitFailure } from '../session-repair-tombstone.ts';
import {
  type DaemonClientSettings,
  type EnsuredDaemon,
  isOneShotReplayCommand,
} from './daemon-client-settings.ts';
import { isRemoteDaemon, stopDaemonMetadataOwnerForTakeover } from './daemon-client-metadata.ts';

/**
 * ADR 0012 decision 6 (BLOCKER 2, third follow-up): a one-shot repair
 * (`replay --save-script`) that COMPLETES without diverging returns SUCCESS
 * here — the actual healed-script COMMIT is deferred to daemon teardown
 * (`finalizeRepairTeardown`, run inside the daemon process's own shutdown
 * handler, triggered by `stopDaemonProcessForTakeover` below). If that
 * deferred commit then FAILS, the daemon leaves a `REPAIR_COMMIT_FAILED`
 * tombstone in this owned state dir — the only surviving record of the
 * failure, since the daemon process (and its in-memory session) is gone by
 * the time this function inspects it. Unconditionally deleting the owned
 * state dir here would silently discard both the failure and the tombstone's
 * re-run guidance, while the CALLER still holds the success response this
 * function already returned. Returns the response the caller should actually
 * use: unchanged, unless an unrecovered commit failure is found, in which
 * case the state dir is preserved (never `rmSync`'d) and the response is
 * overridden to surface it.
 */
export async function cleanupDaemonAfterRequest(
  req: Omit<DaemonRequest, 'token'>,
  daemon: EnsuredDaemon,
  settings: DaemonClientSettings,
  response: DaemonResponse | undefined,
): Promise<DaemonResponse | undefined> {
  if (
    !isOneShotReplayCommand(req.command) ||
    (!daemon.startedByClient && !settings.ownedStateDir) ||
    isRemoteDaemon(daemon.info) ||
    // ADR 0012 decision 6, R7 (Fix 1, C1): a repair-armed `--save-script`
    // replay that comes back as a HELD divergence must keep its owning daemon
    // (and the session on it) addressable for the agent's corrective press +
    // `replay --from`/`close` — tearing it down here is what turns a
    // recoverable divergence into a later bare SESSION_NOT_FOUND. The daemon
    // then bounds the held session's own lifetime via idle-reap (writing a
    // `REPAIR_SESSION_EXPIRED` tombstone on reap), so an abandoned repair still
    // cannot leak indefinitely; this only stops the ONE-SHOT-COMMAND teardown
    // below from racing ahead of that window.
    isHeldRepairDivergence(response) ||
    // ADR 0016: a `replay` whose script had no terminal `close` reports its
    // session as still active by design (the consumption contract this ADR
    // defines) — tearing down its owning daemon here would make that contract
    // unaddressable over the real CLI path the instant the response is sent.
    // Keyed off the session surviving the run (`sessionActive`), never off
    // parsing the script for `close`, so a `--from` resume is covered too.
    // Unlike the repair case, this session has no bounded reap of its own: an
    // unattended close-less replay leaves a live daemon+app session until
    // ordinary idle-reap or an explicit `close` ends it — the same lifetime an
    // interactively opened session already has, and exactly what the ADR's
    // "caller owns close" contract asks for.
    isActiveReplaySessionResponse(req, response)
  ) {
    return response;
  }

  const result = {
    pid: daemon.info.pid,
    removedInfo: false,
    removedLock: false,
    removedStateDir: false,
    error: undefined as string | undefined,
  };
  let surfacedResponse = response;
  let stopConfirmed = false;

  try {
    const removed = await stopDaemonMetadataOwnerForTakeover(settings.paths, daemon.info);
    stopConfirmed = true;
    result.removedInfo = removed.removedInfo;
    result.removedLock = removed.removedLock;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  if (stopConfirmed) {
    if (settings.ownedStateDir) {
      // `stopDaemonProcessForTakeover` above waits for the (real) daemon
      // process to actually exit, which only happens AFTER its shutdown
      // handler finishes `finalizeRepairTeardown` for every session — so by
      // now any commit-failure tombstone it would leave is already on disk.
      const unrecovered = findUnrecoveredRepairCommitFailure(settings.paths.sessionsDir);
      if (unrecovered) {
        surfacedResponse = surfaceUnrecoveredRepairCommitFailure(response, unrecovered);
      } else {
        fs.rmSync(settings.paths.baseDir, { recursive: true, force: true });
        result.removedStateDir = !fs.existsSync(settings.paths.baseDir);
      }
    }
  }

  emitDiagnostic({
    level: result.error ? 'warn' : 'info',
    phase: 'daemon_replay_cleanup',
    data: result,
  });
  return surfacedResponse;
}

/**
 * ADR 0012 decision 6 (BLOCKER 2, third follow-up): converts an unrecovered
 * shutdown-time commit failure into the response the CALLER actually sees.
 * The original response may have been a genuine SUCCESS — the replay/plan
 * itself completed with no divergence, only the deferred healed-script
 * publish failed afterward at teardown — so there is no existing error to
 * attach a hint to (unlike `attachRepairSessionAddressHint`, which only ever
 * runs on an already-`ok:false` divergence): this REPLACES the response with
 * the same `REPAIR_COMMIT_FAILED` error the daemon's own
 * `repairExpiredIfTombstoned` (request-router.ts) would surface to a
 * follow-up request on this session — a one-shot command has no follow-up
 * request to receive it, so the client raises it here instead. An existing
 * `ok:false` response (e.g. the platform close itself failed for a different,
 * more specific reason) is returned unchanged.
 */
function surfaceUnrecoveredRepairCommitFailure(
  response: DaemonResponse | undefined,
  unrecovered: NonNullable<ReturnType<typeof findUnrecoveredRepairCommitFailure>>,
): DaemonResponse {
  if (response && !response.ok) return response;
  const { sessionName, tombstone } = unrecovered;
  const reRun = tombstone.sourcePath
    ? `re-run: replay ${tombstone.sourcePath} --save-script`
    : 're-run your replay <script> --save-script from the start';
  const message =
    `The repair transaction for session "${sessionName}" completed, but committing its ` +
    `healed script failed at teardown: ${tombstone.commitFailure.message}. ${reRun}.`;
  return { ok: false, error: normalizeError(new AppError('REPAIR_COMMIT_FAILED', message)) };
}

/**
 * ADR 0012 decision 6, R7 (Fix 1, C1): true when this response must keep the
 * owning daemon alive — a `REPLAY_DIVERGENCE` whose payload carries the
 * daemon's `resume.repairSessionHeld` liveness signal. The daemon sets that
 * signal from the PERSISTED repair-transaction state (the session is
 * repair-armed and not yet committed), NOT from the current request's
 * `--save-script` flag — so a `replay --from` continuation that does not
 * repeat `--save-script` (R2) is still kept alive if it diverges. Keying the
 * client purely off the signal (the daemon is the authority on transaction
 * state) is what makes that continuation work; a plain, non-repair divergence
 * carries no signal and gets no keep-alive. Also independent of
 * `resume.allowed` (plan-resumability): a held divergence with `allowed: false`
 * still holds the session so the agent can inspect and `close` cleanly.
 */
export function isHeldRepairDivergence(response: DaemonResponse | undefined): boolean {
  if (!response || response.ok) return false;
  if (response.error.code !== 'REPLAY_DIVERGENCE') return false;
  const resume = readReplayDivergenceResume(response.error.details?.divergence);
  return resume?.repairSessionHeld === true;
}

/**
 * ADR 0012 decision 6 (Fix 1): "keep it addressable" — an owned ephemeral
 * daemon lives at a randomly generated `--state-dir` (`createOwnedReplayStateDir`)
 * that no other invocation knows about, so keeping the process alive is not
 * enough on its own. Appended (never overwriting an existing hint, e.g. a
 * selector-miss's own guidance) so the agent's next command knows to target
 * the SAME daemon instead of resolving to the default one.
 */
export function attachRepairSessionAddressHint(
  response: Extract<DaemonResponse, { ok: false }>,
  stateDir: string,
): Extract<DaemonResponse, { ok: false }> {
  const addressHint =
    `This repair session's daemon was kept alive to continue the repair; pass ` +
    `--state-dir ${stateDir} on your next command (press, replay --from, or ` +
    `close --save-script) to reach it.`;
  const existingHint = response.error.hint;
  return {
    ...response,
    error: {
      ...response.error,
      hint: existingHint ? `${existingHint} ${addressHint}` : addressHint,
    },
  };
}

/**
 * ADR 0016: true when a successful `replay` response reports its session as
 * still active (`ReplayCommandResult.sessionActive`, set by the daemon from
 * whether the session survived in its own store — never derived here by
 * re-parsing the script). Restricted to `replay` itself, never `test`: a
 * `test` run's own per-file runner already closes each session before the
 * suite summary is built, and its `ReplaySuiteResult` carries no such field
 * anyway, but the explicit command check keeps that carve-out a decision
 * rather than an accident of the response shape.
 */
export function isActiveReplaySessionResponse(
  req: Omit<DaemonRequest, 'token'>,
  response: DaemonResponse | undefined,
): boolean {
  if (req.command !== PUBLIC_COMMANDS.replay) return false;
  if (!response || !response.ok) return false;
  return response.data?.sessionActive === true;
}

/**
 * ADR 0016 counterpart to `attachRepairSessionAddressHint`: a still-active
 * replay session is only unaddressable by `--state-dir` when it lives on an
 * OWNED, randomly generated one (`stateDir` undefined otherwise — an explicit
 * `--state-dir`/`AGENT_DEVICE_STATE_DIR` caller already knows it). But the
 * SESSION name is always cwd-qualified (`cwd:<hash>:default`) and, per #1394,
 * `session list` cannot rediscover it either — so `--session` is always
 * emitted when a name is available, explicit state dir or not. Attached to
 * both a structured `hint` field (for `--json` consumers) and appended to
 * `message` — the only field the default text renderer surfaces
 * (`@agent-device/kernel/success-text`) — so the hint reaches a caller in either mode.
 *
 * `data.session` is used verbatim, never reconstructed as `default`: an
 * EXPLICIT `--session <value>` is used as-is by `resolveEffectiveSessionName`,
 * skipping cwd-scoping entirely (`hasExplicitSessionFlag`), so passing the
 * qualified name back unchanged is what actually reaches the same session
 * from any cwd — a bare `--session default` would only match by coincidence
 * (an implicit, no-`--session` follow-up run from the identical cwd). Both
 * the state dir and the session name are shell-quoted (only when needed) so
 * the hint stays literally copy-pasteable even if either contains spaces or
 * shell metacharacters.
 */
export function attachActiveSessionAddressHint(
  response: Extract<DaemonResponse, { ok: true }>,
  stateDir: string | undefined,
): Extract<DaemonResponse, { ok: true }> {
  const data = response.data ?? {};
  const sessionName = typeof data.session === 'string' ? data.session : undefined;
  const addressFlags = [
    ...(stateDir ? [`--state-dir ${shellQuoteIfNeeded(stateDir)}`] : []),
    ...(sessionName ? [`--session ${shellQuoteIfNeeded(sessionName)}`] : []),
  ];
  if (addressFlags.length === 0) return response;
  const addressHint =
    `This session's daemon was kept alive because its script left the session active; ` +
    `pass ${addressFlags.join(' ')} on your next command to reach it.`;
  const existingMessage = typeof data.message === 'string' ? data.message : undefined;
  return {
    ...response,
    data: {
      ...data,
      hint: addressHint,
      message: existingMessage ? `${existingMessage} ${addressHint}` : addressHint,
    },
  };
}
