import type { AgentDeviceClientConfig, StopLocalDaemon } from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import { resolveDaemonPaths } from '../daemon-resolution.ts';
import { resolveDeviceClaimRootPath } from '../device-claim-root.ts';

export function createClientDaemonLifecycle(
  config: AgentDeviceClientConfig,
  injectedStop?: StopLocalDaemon,
) {
  const daemonBaseUrl = snapshotDaemonBaseUrl(config.daemonBaseUrl);
  const stateDirSelection = snapshotDaemonStateDirSelection(config.stateDir);
  const deviceClaimRootSelection = snapshotDeviceClaimRootSelection(config.deviceClaimsDir);
  config = {
    ...config,
    ...(daemonBaseUrl ? { daemonBaseUrl } : {}),
    ...(stateDirSelection.path ? { stateDir: stateDirSelection.path } : {}),
    deviceClaimsDir: deviceClaimRootSelection.path,
  };
  const stopLocalDaemon: StopLocalDaemon =
    injectedStop ??
    (async (input) =>
      await (await import('../daemon-client/daemon-client-stop.ts')).stopLocalDaemon(input));
  let daemonStopPromise: ReturnType<StopLocalDaemon> | undefined;
  let daemonStopState: 'idle' | 'stopping' | 'stopped' = 'idle';

  return {
    config,
    daemonBaseUrl,
    transportContext: {
      daemonBaseUrlPolicy: daemonBaseUrl ?? null,
      deviceClaimsDir: config.deviceClaimsDir,
      deviceClaimsDirExplicit: deviceClaimRootSelection.explicit,
    },
    beforeRequest: () => {
      if (daemonStopState === 'stopping') {
        throw new AppError('COMMAND_FAILED', 'A daemon stop is already in progress.', {
          reason: 'daemon_stop_in_progress',
        });
      }
      if (daemonStopState === 'stopped') {
        daemonStopState = 'idle';
        daemonStopPromise = undefined;
      }
    },
    stop: async () => {
      assertDaemonStopConfiguration(
        config,
        stateDirSelection.explicit,
        deviceClaimRootSelection.explicit,
      );
      if (daemonStopPromise) return await daemonStopPromise;
      daemonStopState = 'stopping';
      daemonStopPromise = Promise.resolve().then(() =>
        stopLocalDaemon({
          stateDir: config.stateDir!,
          deviceClaimsDir: config.deviceClaimsDir!,
        }),
      );
      void daemonStopPromise.then(
        (result) => {
          if (result.kind === 'stopped') {
            daemonStopState = 'stopped';
            return;
          }
          daemonStopState = 'idle';
          daemonStopPromise = undefined;
        },
        () => {
          daemonStopState = 'idle';
          daemonStopPromise = undefined;
        },
      );
      return await daemonStopPromise;
    },
  };
}

function snapshotDeviceClaimRootSelection(value: string | undefined): {
  path: string;
  explicit: boolean;
} {
  const environmentValue = process.env.AGENT_DEVICE_CLAIMS_DIR;
  const configured = value ?? environmentValue;
  if (value !== undefined && value.trim().length === 0) {
    throw new AppError('INVALID_ARGS', 'deviceClaimsDir must be a non-empty string.');
  }
  return {
    path: resolveDeviceClaimRootPath(configured?.trim() ? configured : undefined),
    explicit: value !== undefined,
  };
}

function snapshotDaemonStateDirSelection(value: string | undefined): {
  path?: string;
  explicit: boolean;
} {
  if (value === undefined) return { explicit: false };
  if (value.trim().length === 0) {
    throw new AppError('INVALID_ARGS', 'stateDir must be a non-empty string.');
  }
  return { path: resolveDaemonPaths(value).baseDir, explicit: true };
}

function snapshotDaemonBaseUrl(value: string | undefined): string | undefined {
  const effective = value ?? process.env.AGENT_DEVICE_DAEMON_BASE_URL;
  const normalized = effective?.trim();
  return normalized ? normalized : undefined;
}

function assertDaemonStopConfiguration(
  config: AgentDeviceClientConfig,
  stateDirExplicit: boolean,
  deviceClaimsDirExplicit: boolean,
): void {
  if (config.daemonBaseUrl) {
    throw new AppError('INVALID_ARGS', 'daemon.stop() is available only for a local daemon.', {
      reason: 'daemon_stop_remote_refused',
    });
  }
  if (!stateDirExplicit || !deviceClaimsDirExplicit) {
    throw new AppError(
      'INVALID_ARGS',
      'daemon.stop() requires explicit stateDir and deviceClaimsDir construction policy.',
      {
        reason: 'daemon_stop_authority_not_explicit',
        stateDirExplicit,
        deviceClaimsDirExplicit,
      },
    );
  }
}
