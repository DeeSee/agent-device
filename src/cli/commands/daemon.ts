import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import {
  applyDaemonShutdownReport,
  readDaemonAuthorityIdentity,
  readDaemonStopIdentity,
  stopDaemon,
  type DaemonStopResult,
} from '../../daemon-stop.ts';
import { readDaemonShutdownReport } from '../../daemon-shutdown-report.ts';
import { AppError } from '@agent-device/kernel/errors';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';
import { createDaemonOwnerCleanup } from '../../platform-runtime-daemon-owner-cleanup.ts';

const daemonOwnerCleanup = createDaemonOwnerCleanup();

export const daemonCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  const subcommand = positionals[0];
  if (subcommand !== 'stop' || positionals.length !== 1) {
    throw new AppError('INVALID_ARGS', 'daemon accepts only: stop');
  }
  const paths = resolveDaemonPaths(flags.stateDir);
  const identity = readDaemonStopIdentity(paths.infoPath);
  const authorityIdentity = readDaemonAuthorityIdentity(paths.infoPath);
  const stopped = await stopDaemon({
    paths,
    ...(authorityIdentity ? { expectedIdentity: authorityIdentity } : {}),
  });
  const report = stopped.mode === 'graceful' ? readDaemonShutdownReport(paths.baseDir) : null;
  const result = applyDaemonShutdownReport(stopped, report, authorityIdentity);
  const shouldClean = flags.clean === true && identity !== null && result.stopped;
  if (shouldClean) {
    await daemonOwnerCleanup.cleanup({
      pid: identity.pid,
      startTime: identity.processStartTime,
    });
  }
  const data = { ...result, clean: shouldClean };
  await writeCommandOutput(flags, data, () => renderDaemonStop(data));
  return true;
};

function renderDaemonStop(
  result: Pick<DaemonStopResult, 'stopped' | 'mode' | 'warnings'> & {
    clean: boolean;
  },
): string {
  const headline = result.stopped
    ? `Daemon stopped (${result.mode}).`
    : result.mode === 'grace-timeout'
      ? 'Daemon still running (graceful stop timed out).'
      : 'No running daemon found.';
  return [headline, result.clean ? 'Retained runner cleanup completed.' : null, ...result.warnings]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
