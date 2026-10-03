import { AppError } from '@agent-device/kernel/errors';

export type DaemonEntrypointOptions = {
  deviceClaimsDir?: string;
};

export function readDaemonEntrypointOptions(argv: readonly string[]): DaemonEntrypointOptions {
  if (argv.length === 0) return {};
  if (
    argv.length === 2 &&
    argv[0] === '--device-claims-dir' &&
    typeof argv[1] === 'string' &&
    argv[1].trim().length > 0
  ) {
    return { deviceClaimsDir: argv[1] };
  }
  throw new AppError('INVALID_ARGS', 'Daemon accepts only --device-claims-dir <non-empty path>.');
}
