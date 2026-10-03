// The public API vocabulary for how a client reaches a daemon and selects a device.

import type {
  DaemonLockPolicy,
  DaemonRequest,
  DaemonResponse,
  LeaseBackend,
  ResponseLevel,
  SessionIsolationMode,
  SessionRuntimeHints,
} from '@agent-device/kernel/contracts';
import type { DeviceTarget, PlatformSelector } from '@agent-device/kernel/device';
import type {
  CloudProviderProfileFields,
  RemoteConnectionProfileFields,
} from './remote-config-fields.ts';

export type AgentDeviceDaemonTransportContext = {
  authToken?: string;
  /** Request-scoped cancellation; never serialized into the daemon request. */
  signal?: AbortSignal;
  /** Construction-snapshotted remote policy; null suppresses later environment drift. */
  daemonBaseUrlPolicy?: string | null;
  /** Construction-scoped local daemon policy; never serialized into a command request. */
  deviceClaimsDir?: string;
  /** True only for an explicit client config value, not an env/default snapshot. */
  deviceClaimsDirExplicit?: boolean;
};

export type AgentDeviceDaemonTransport = (
  req: Omit<DaemonRequest, 'token'>,
  context?: AgentDeviceDaemonTransportContext,
) => Promise<DaemonResponse>;

export type AgentDeviceDaemonIdentity = Readonly<{
  pid: number;
  processStartTime: string;
  version: string;
  codeSignature: string;
  deviceClaimRootId: string;
}>;

export type AgentDeviceDaemonCleanupEvidence = Readonly<{
  providerReleases: Readonly<{
    released: readonly Readonly<{ leaseId: string; provider?: string }>[];
    pending: readonly Readonly<{ leaseId: string; provider?: string }>[];
  }>;
  claims: Readonly<{
    released: readonly AgentDeviceDaemonClaimEvidence[];
    orphaned: readonly AgentDeviceDaemonClaimEvidence[];
    superseded: readonly AgentDeviceDaemonClaimEvidence[];
    unattributable: readonly AgentDeviceDaemonClaimEvidence[];
  }>;
}>;

export type AgentDeviceDaemonClaimEvidence = Readonly<{
  deviceKey: string;
  session: string;
  platform: string;
  deviceId: string;
}>;

export type AgentDeviceDaemonCleanupResult =
  | Readonly<{ kind: 'complete'; evidence: AgentDeviceDaemonCleanupEvidence }>
  | Readonly<{
      kind: 'incomplete';
      reasons: readonly (
        | 'provider_releases_pending'
        | 'device_claims_orphaned'
        | 'device_claims_unattributable'
      )[];
      evidence: AgentDeviceDaemonCleanupEvidence;
    }>
  | Readonly<{
      kind: 'unknown';
      reason:
        | 'daemon_not_running'
        | 'grace_timeout'
        | 'shutdown_report_unavailable_or_invalid'
        | 'shutdown_report_identity_mismatch';
    }>;

export type AgentDeviceDaemonStopResult =
  | Readonly<{
      kind: 'stopped';
      mode: 'graceful';
      identity: AgentDeviceDaemonIdentity;
      cleanup: AgentDeviceDaemonCleanupResult;
    }>
  | Readonly<{
      kind: 'still_running';
      mode: 'grace_timeout';
      identity: AgentDeviceDaemonIdentity;
      cleanup: Readonly<{ kind: 'unknown'; reason: 'grace_timeout' }>;
    }>
  | Readonly<{
      kind: 'not_running';
      mode: 'not_running';
      identity: null;
      cleanup: Readonly<{ kind: 'unknown'; reason: 'daemon_not_running' }>;
    }>;

export type AgentDeviceClientConfig = RemoteConnectionProfileFields &
  CloudProviderProfileFields & {
    session?: string;
    lockPolicy?: DaemonLockPolicy;
    lockPlatform?: PlatformSelector;
    requestId?: string;
    sessionIsolation?: SessionIsolationMode;
    leaseBackend?: LeaseBackend;
    leaseTtlMs?: number;
    runtime?: SessionRuntimeHints;
    cwd?: string;
    debug?: boolean;
    cost?: boolean;
    responseLevel?: ResponseLevel;
    /**
     * Immutable host-local device-claim root for this client/daemon authority.
     * It is client construction policy, never a per-request override.
     */
    deviceClaimsDir?: string;
    iosXctestrunFile?: string;
    iosXctestDerivedDataPath?: string;
    iosXctestEnvDir?: string;
  };

export type AgentDeviceRequestOverrides = Pick<
  AgentDeviceClientConfig,
  | 'session'
  | 'lockPolicy'
  | 'lockPlatform'
  | 'requestId'
  | 'daemonBaseUrl'
  | 'daemonAuthToken'
  | 'daemonTransport'
  | 'daemonServerMode'
  | 'tenant'
  | 'sessionIsolation'
  | 'runId'
  | 'leaseId'
  | 'leaseBackend'
  | 'leaseProvider'
  | 'deviceKey'
  | 'clientId'
  | 'providerApp'
  | 'providerOsVersion'
  | 'providerProject'
  | 'providerBuild'
  | 'providerSessionName'
  | 'providerDeviceOrientation'
  | 'providerGeoLocation'
  | 'providerTimezone'
  | 'providerAppiumVersion'
  | 'providerLanguage'
  | 'providerLocale'
  | 'providerNetworkProfile'
  | 'providerCustomNetwork'
  | 'providerNoResignApp'
  | 'awsProjectArn'
  | 'awsDeviceArn'
  | 'awsAppArn'
  | 'awsRegion'
  | 'awsInteractionMode'
  | 'leaseTtlMs'
  | 'cwd'
  | 'debug'
  | 'cost'
  | 'responseLevel'
  | 'iosXctestrunFile'
  | 'iosXctestDerivedDataPath'
  | 'iosXctestEnvDir'
> & {
  /** Cancels only this request and its request-owned platform work. */
  signal?: AbortSignal;
};

export type AgentDeviceIdentifiers = {
  session?: string;
  deviceId?: string;
  deviceName?: string;
  udid?: string;
  serial?: string;
  appId?: string;
  appBundleId?: string;
  package?: string;
};

export type AgentDeviceSelectionOptions = {
  platform?: PlatformSelector;
  target?: DeviceTarget;
  device?: string;
  udid?: string;
  serial?: string;
  iosSimulatorDeviceSet?: string;
  androidDeviceAllowlist?: string;
};

export type DeviceCommandBaseOptions = AgentDeviceRequestOverrides & AgentDeviceSelectionOptions;

export type StopLocalDaemonInput = Readonly<{ stateDir: string; deviceClaimsDir: string }>;
export type StopLocalDaemon = (input: StopLocalDaemonInput) => Promise<AgentDeviceDaemonStopResult>;
