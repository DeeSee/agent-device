import type { DeviceInfo } from '@agent-device/kernel/device';
import type { JsonObject } from './json.ts';

/** A short-lived install source supplied by the daemon after request validation. */
export type AppDeploymentSource =
  | Readonly<{ kind: 'url'; url: string; headers?: Readonly<Record<string, string>> }>
  | Readonly<{ kind: 'path'; path: string }>;

/**
 * Request-scoped materialization. The daemon owns cleanup and retention; this handle must never
 * be persisted into session state or a durable resource envelope.
 */
export type MaterializedAppSource = Readonly<{
  archivePath?: string;
  installablePath: string;
  bundleId?: string;
  packageName?: string;
  appName?: string;
  cleanup(): Promise<void>;
}>;

export type AppDeploymentInput = Readonly<{
  app: string;
  appPath: string;
  replaceExisting: boolean;
}>;

export type AppDeploymentResult = Readonly<{
  bundleId?: string;
  packageName?: string;
  appName?: string;
  launchTarget?: string;
}>;

export type MaterializeAppSourceInput = Readonly<{
  source: AppDeploymentSource;
}>;

export type DeployMaterializedAppInput = Readonly<{
  artifact: MaterializedAppSource;
}>;

export type PushNotificationInput = Readonly<{
  appId: string;
  payload: JsonObject;
}>;

export type PushNotificationResult = Readonly<{
  action?: string;
  extrasCount?: number;
}>;

export type AppContainerWriteJsonInput = Readonly<{
  app: string;
  containerPath: string;
  value: JsonObject;
}>;

export type AppContainerReadJsonInput = Readonly<{
  app: string;
  containerPath: string;
}>;

export type AppContainerReadJsonResult = Readonly<{
  appId: string;
  containerPath: string;
  sha256: string;
  byteLength: number;
  value: JsonObject;
}>;

export const APP_CONTAINER_JSON_MAX_BYTES = 256 * 1024;
const APP_CONTAINER_JSON_MAX_DEPTH = 128;

export function isBoundedAppContainerJsonObject(value: unknown): value is JsonObject {
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, depth: number): boolean => {
    if (depth > APP_CONTAINER_JSON_MAX_DEPTH) return false;
    if (candidate === null || typeof candidate !== 'object') return isJsonPrimitive(candidate);
    if (ancestors.has(candidate)) return false;
    if (!Array.isArray(candidate) && !isJsonRecord(candidate)) return false;
    ancestors.add(candidate);
    const valid = Object.values(candidate).every((child) => visit(child, depth + 1));
    ancestors.delete(candidate);
    return valid;
  };
  return isJsonRecord(value) && visit(value, 0);
}

function isJsonPrimitive(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return value === null || typeof value === 'string' || typeof value === 'boolean';
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export type AppContainerWriteJsonResult = Readonly<{
  appId: string;
  containerPath: string;
  sha256: string;
  byteLength: number;
  verified: true;
}>;

/** The request-scoped deployment facet; no operation creates a durable resource. */
export type AppDeploymentRuntimeOperations = Readonly<{
  deployApp(input: AppDeploymentInput): Promise<AppDeploymentResult>;
  materializeAppSource(input: MaterializeAppSourceInput): Promise<MaterializedAppSource>;
  deployMaterializedApp(input: DeployMaterializedAppInput): Promise<AppDeploymentResult>;
  sendPushNotification(input: PushNotificationInput): Promise<PushNotificationResult>;
  writeAppContainerJson(input: AppContainerWriteJsonInput): Promise<AppContainerWriteJsonResult>;
  readAppContainerJson(input: AppContainerReadJsonInput): Promise<AppContainerReadJsonResult>;
}>;

/**
 * The Apple package owns deployment sequencing. Composition supplies only these native executor
 * calls, each scoped to the request binding that initiated it.
 */
export type AppleAppDeploymentExecutor = Readonly<{
  /** Brackets a full reinstall so fuzzy iOS app identity cannot survive a partial replacement. */
  withInvalidatedAppResolutionCache<Result>(
    device: DeviceInfo,
    operation: () => Promise<Result>,
  ): Promise<Result>;
  prepareArtifact(
    input: MaterializeAppSourceInput,
    options: Readonly<{ appIdentifierHint?: string; signal: AbortSignal }>,
  ): Promise<MaterializedAppSource>;
  resolveAppBundleId(device: DeviceInfo, app: string): Promise<string>;
  writeAppContainerJson(
    device: DeviceInfo,
    input: Readonly<{
      appId: string;
      containerPath: string;
      serializedValue: string;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ sha256: string; byteLength: number }>>;
  readAppContainerJson(
    device: DeviceInfo,
    input: Readonly<{ appId: string; containerPath: string }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ sha256: string; byteLength: number; value: JsonObject }>>;
}>;

/**
 * The Android package owns deployment sequencing and native command construction. Composition
 * supplies only the temporary legacy artifact and fuzzy-resolution seams.
 */
export type AndroidAppDeploymentExecutor = Readonly<{
  /** Inert composition-time configuration; command construction remains package-owned. */
  bundletoolJar?: string;
  /** Brackets one deploy lifecycle so fuzzy target resolution is clear before and after it. */
  withInvalidatedAppResolutionCache<Result>(
    device: DeviceInfo,
    operation: () => Promise<Result>,
  ): Promise<Result>;
  prepareArtifact(
    input: MaterializeAppSourceInput,
    options: Readonly<{ resolveIdentity?: boolean; signal: AbortSignal }>,
  ): Promise<MaterializedAppSource>;
  resolveAppPackage(device: DeviceInfo, app: string): Promise<string>;
}>;

export function checkAppContainerJsonPath(
  value: unknown,
): { valid: true; path: string } | { valid: false; message: string } {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0'))
    return { valid: false, message: 'containerPath must be a non-empty string' };
  if (
    value.length > 1024 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    return {
      valid: false,
      message: 'containerPath must be a normalized relative app data container JSON path',
    };
  return { valid: true, path: value };
}
