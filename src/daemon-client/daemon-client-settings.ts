import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { DaemonWireRequest as DaemonRequest } from '@agent-device/contracts/command';
import { openDeviceClaimRoot, type DeviceClaimRoot } from '../device-claim-root.ts';
import {
  resolveDaemonPaths,
  resolveDaemonServerMode,
  resolveDaemonTransportPreference,
  type DaemonPaths,
  type DaemonServerMode,
  type DaemonTransportPreference,
} from '../daemon-resolution.ts';
import type { DaemonInfo } from './daemon-client-metadata.ts';

export type DaemonClientSettings = {
  paths: DaemonPaths;
  deviceClaimRoot?: DeviceClaimRoot;
  explicitDeviceClaimsDir?: boolean;
  transportPreference: DaemonTransportPreference;
  serverMode: DaemonServerMode;
  ownedStateDir?: boolean;
  remoteBaseUrl?: string;
  remoteAuthToken?: string;
};

export type EnsuredDaemon = {
  info: DaemonInfo;
  startedByClient: boolean;
};

const LOOPBACK_BLOCK_LIST = new net.BlockList();

LOOPBACK_BLOCK_LIST.addSubnet('127.0.0.0', 8, 'ipv4');

LOOPBACK_BLOCK_LIST.addAddress('::1', 'ipv6');

LOOPBACK_BLOCK_LIST.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

export function resolveClientSettings(
  req: Omit<DaemonRequest, 'token'>,
  suppliedAuthToken?: string,
  configuredDeviceClaimsDir?: string,
  configuredDeviceClaimsDirIsExplicit = configuredDeviceClaimsDir !== undefined,
  configuredDaemonBaseUrl: string | null | undefined = undefined,
): DaemonClientSettings {
  const explicitStateDir = resolveExplicitStateDir(req);
  const deviceClaimsDir = readConfiguredDeviceClaimsDir(configuredDeviceClaimsDir);
  const remote = resolveRemoteClientSettings(req, suppliedAuthToken, configuredDaemonBaseUrl);
  if (remote.remoteBaseUrl && configuredDeviceClaimsDirIsExplicit) {
    throw new AppError(
      'INVALID_ARGS',
      'deviceClaimsDir configures a local daemon and cannot be used with a remote daemon.',
    );
  }
  const transport = resolveTransportClientSettings(req, remote.remoteBaseUrl);
  const ownedStateDir = shouldUseOwnedReplayStateDir(req, explicitStateDir, remote.rawBaseUrl);
  const stateDir = ownedStateDir ? createOwnedReplayStateDir() : explicitStateDir;
  const deviceClaimRoot = remote.remoteBaseUrl ? undefined : openDeviceClaimRoot(deviceClaimsDir);
  return {
    paths: resolveDaemonPaths(stateDir),
    deviceClaimRoot,
    explicitDeviceClaimsDir: configuredDeviceClaimsDirIsExplicit,
    transportPreference: transport.preference,
    serverMode: transport.serverMode,
    ownedStateDir,
    remoteBaseUrl: remote.remoteBaseUrl,
    remoteAuthToken: remote.authToken,
  };
}

function readConfiguredDeviceClaimsDir(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('INVALID_ARGS', 'deviceClaimsDir must be a non-empty string.');
  }
  return value;
}

function resolveExplicitStateDir(req: Omit<DaemonRequest, 'token'>): string | undefined {
  return req.flags?.stateDir ?? process.env.AGENT_DEVICE_STATE_DIR;
}

function resolveRemoteClientSettings(
  req: Omit<DaemonRequest, 'token'>,
  suppliedAuthToken: string | undefined,
  configuredDaemonBaseUrl: string | null | undefined,
): {
  rawBaseUrl: string | undefined;
  remoteBaseUrl?: string;
  authToken?: string;
} {
  const rawBaseUrl =
    req.flags?.daemonBaseUrl ??
    (configuredDaemonBaseUrl === null
      ? undefined
      : (configuredDaemonBaseUrl ?? process.env.AGENT_DEVICE_DAEMON_BASE_URL));
  const remoteBaseUrl = resolveRemoteDaemonBaseUrl(rawBaseUrl);
  const authToken = suppliedAuthToken ?? process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  validateRemoteDaemonTrust(remoteBaseUrl, authToken);
  return { rawBaseUrl, remoteBaseUrl, authToken };
}

function resolveTransportClientSettings(
  req: Omit<DaemonRequest, 'token'>,
  remoteBaseUrl: string | undefined,
): { preference: DaemonTransportPreference; serverMode: DaemonServerMode } {
  const rawTransport = req.flags?.daemonTransport ?? process.env.AGENT_DEVICE_DAEMON_TRANSPORT;
  const preference = resolveDaemonTransportPreference(rawTransport);
  if (remoteBaseUrl && preference === 'socket') {
    throw new AppError(
      'INVALID_ARGS',
      'Remote daemon base URL only supports HTTP transport. Remove --daemon-transport socket.',
      { daemonBaseUrl: remoteBaseUrl },
    );
  }
  const rawServerMode =
    req.flags?.daemonServerMode ??
    process.env.AGENT_DEVICE_DAEMON_SERVER_MODE ??
    (rawTransport === 'dual' ? 'dual' : undefined);
  return {
    preference,
    serverMode: resolveDaemonServerMode(rawServerMode),
  };
}

function shouldUseOwnedReplayStateDir(
  req: Omit<DaemonRequest, 'token'>,
  explicitStateDir: string | undefined,
  rawRemoteBaseUrl: string | undefined,
): boolean {
  return isOneShotReplayCommand(req.command) && !explicitStateDir && !rawRemoteBaseUrl;
}

function createOwnedReplayStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-daemon-'));
}

export function refuseClaimRootMismatch(
  info: DaemonInfo,
  reachable: boolean,
  settings: DaemonClientSettings,
): void {
  if (!reachable) return;
  const expectedRootId = requireLocalDeviceClaimRoot(settings).id;
  if (info.deviceClaimRootId === expectedRootId) return;
  if (!settings.explicitDeviceClaimsDir && info.deviceClaimRootId === undefined) return;
  throw new AppError(
    'COMMAND_FAILED',
    'The running agent-device daemon uses a different device-claim root.',
    {
      reason: 'device_claim_root_mismatch',
      expectedRootId,
      actualRootId: info.deviceClaimRootId ?? null,
      hint: 'Close the existing daemon and retry with one immutable deviceClaimsDir.',
    },
  );
}

export function isOneShotReplayCommand(command: string | undefined): boolean {
  return command === PUBLIC_COMMANDS.replay || command === PUBLIC_COMMANDS.test;
}

export function requireLocalDeviceClaimRoot(settings: DaemonClientSettings): DeviceClaimRoot {
  if (settings.deviceClaimRoot) return settings.deviceClaimRoot;
  throw new AppError('COMMAND_FAILED', 'A local daemon requires a device-claim root.', {
    reason: 'device_claim_root_missing',
  });
}

function resolveRemoteDaemonBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid daemon base URL',
      {
        daemonBaseUrl: raw,
      },
      error instanceof Error ? error : undefined,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('INVALID_ARGS', 'Daemon base URL must use http or https', {
      daemonBaseUrl: raw,
    });
  }
  return parsed.toString().replace(/\/+$/, '');
}

function validateRemoteDaemonTrust(
  remoteBaseUrl: string | undefined,
  remoteAuthToken: string | undefined,
): void {
  if (!remoteBaseUrl) return;
  const hostname = new URL(remoteBaseUrl).hostname;
  if (isLoopbackHostname(hostname)) return;
  if (typeof remoteAuthToken === 'string' && remoteAuthToken.trim().length > 0) return;
  throw new AppError(
    'INVALID_ARGS',
    'Remote daemon base URL for non-loopback hosts requires daemon authentication',
    {
      daemonBaseUrl: remoteBaseUrl,
      hint: 'Provide --daemon-auth-token or AGENT_DEVICE_DAEMON_AUTH_TOKEN when using a non-loopback remote daemon URL.',
    },
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost') return true;
  if (net.isIPv4(normalized)) return LOOPBACK_BLOCK_LIST.check(normalized, 'ipv4');
  if (net.isIPv6(normalized)) return LOOPBACK_BLOCK_LIST.check(normalized, 'ipv6');
  return false;
}
