import { startDaemonRuntime } from './daemon/server/daemon-runtime.ts';
import { readDaemonEntrypointOptions } from './daemon/daemon-entrypoint-options.ts';
import { asAppError } from '@agent-device/kernel/errors';

void startDaemonRuntime(readDaemonEntrypointOptions(process.argv.slice(2))).catch((error) => {
  const appErr = asAppError(error);
  process.stderr.write(`Daemon error: ${appErr.message}\n`);
  process.exit(1);
});
