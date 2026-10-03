import type {
  AppContainerWriteJsonInput,
  AppContainerWriteJsonResult,
  AppDeploymentInput,
  AppDeploymentResult,
  AppDeploymentRuntimeOperations,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
  PushNotificationInput,
} from '@agent-device/contracts/app-deployment-runtime';
import type {
  AppleToolRequest,
  HostCommandResult,
} from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { isMissingAppErrorOutput } from '../core/physical-device-apps.ts';
import { IOS_DEVICE_INSTALL_TIMEOUT_MS } from '../core/config.ts';
import { IOS_DEVICECTL_DEFAULT_HINT, resolveIosDevicectlHint } from '../core/devicectl.ts';
import { ensureAppleReady } from '../readiness/runtime.ts';
import { scopeSimctlArgsForDevice } from '../core/simctl.ts';

const available = Object.freeze({ available: true } as const);
const APP_CONTAINER_JSON_MAX_BYTES = 256 * 1024;
const coreDeviceRequired = Object.freeze({
  available: false,
  reason: 'unsupported-device-backend',
  hint: 'This command requires a CoreDevice-backed physical iOS device. The selected XCTest backend supports open, close, interactions, snapshots, and screenshots.',
} as const);
const simulatorOnly = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Push notifications are supported on Apple simulators only.',
} as const);
const unsupportedLeaf = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const unsupportedKind = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
} as const);

export function appleAppDeploymentFacts(device: DeviceInfo): Readonly<{
  deployApp: RuntimeOperationFact;
  materializeAppSource: RuntimeOperationFact;
  deployMaterializedApp: RuntimeOperationFact;
  sendPushNotification: RuntimeOperationFact;
  writeAppContainerJson: RuntimeOperationFact;
}> {
  const deploy = appleDeployFact(device);
  return Object.freeze({
    deployApp: deploy,
    materializeAppSource: deploy,
    deployMaterializedApp: deploy,
    sendPushNotification: applePushFact(device),
    writeAppContainerJson: appleContainerJsonFact(device),
  });
}

export function createAppleAppDeploymentOperations(params: {
  host: PlatformRuntimeHost;
  device: DeviceInfo;
  signal: AbortSignal;
}): Partial<AppDeploymentRuntimeOperations> {
  const { host, device, signal } = params;
  const facts = appleAppDeploymentFacts(device);
  return Object.freeze({
    ...(facts.deployApp.available
      ? {
          deployApp: async (input: AppDeploymentInput) =>
            await deployAppleApp(host, device, input, signal),
          materializeAppSource: async (input: MaterializeAppSourceInput) =>
            await host.appleDeployment.prepareArtifact(input, { signal }),
          deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
            await deployPreparedAppleApp(host, device, input, signal),
        }
      : {}),
    ...(facts.sendPushNotification.available
      ? {
          sendPushNotification: async (input: PushNotificationInput) => {
            await pushAppleNotification(host, device, input, signal);
            return {};
          },
        }
      : {}),
    ...(facts.writeAppContainerJson.available
      ? {
          writeAppContainerJson: async (input: AppContainerWriteJsonInput) =>
            await writeAppleAppContainerJson(host, device, input, signal),
        }
      : {}),
  });
}

async function writeAppleAppContainerJson(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: AppContainerWriteJsonInput,
  signal: AbortSignal,
): Promise<AppContainerWriteJsonResult> {
  const serializedValue = `${JSON.stringify(input.value)}\n`;
  const byteLength = Buffer.byteLength(serializedValue, 'utf8');
  if (byteLength > APP_CONTAINER_JSON_MAX_BYTES) {
    throw new AppError(
      'INVALID_ARGS',
      `App container JSON must not exceed ${APP_CONTAINER_JSON_MAX_BYTES} bytes`,
    );
  }
  await ensureAppleReady(host, device, signal);
  const appId = await host.appleDeployment.resolveAppBundleId(device, input.app);
  const receipt = await host.appleDeployment.writeAppContainerJson(
    device,
    { appId, containerPath: input.containerPath, serializedValue },
    signal,
  );
  return {
    appId,
    containerPath: input.containerPath,
    sha256: receipt.sha256,
    byteLength: receipt.byteLength,
    verified: true,
  };
}

async function deployAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: AppDeploymentInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  // Preserve reinstall's established partial-failure boundary: the old route resolved and
  // removed the selected app before it materialized the replacement artifact. That ordering is
  // observable when artifact preparation fails, so it belongs to the platform deployment facet.
  if (input.replaceExisting) {
    return await host.appleDeployment.withInvalidatedAppResolutionCache(device, async () => {
      const appHint = input.app.trim();
      if (appHint) {
        const bundleId = await host.appleDeployment.resolveAppBundleId(device, appHint);
        await uninstallAppleApp(host, device, bundleId, signal);
        const artifact = await host.appleDeployment.prepareArtifact(
          { source: { kind: 'path', path: input.appPath } },
          { appIdentifierHint: appHint, signal },
        );
        try {
          await installAppleApp(host, device, artifact.installablePath, signal);
          return { bundleId, launchTarget: bundleId };
        } finally {
          await artifact.cleanup();
        }
      }

      const artifact = await host.appleDeployment.prepareArtifact(
        { source: { kind: 'path', path: input.appPath } },
        { signal },
      );
      try {
        const bundleId = artifact.bundleId;
        if (!bundleId) {
          throw new AppError(
            'INVALID_ARGS',
            'Could not determine the app bundle identifier from the replacement artifact',
          );
        }
        await uninstallAppleApp(host, device, bundleId, signal);
        await installAppleApp(host, device, artifact.installablePath, signal);
        return { bundleId, launchTarget: bundleId };
      } finally {
        await artifact.cleanup();
      }
    });
  }

  const artifact = await host.appleDeployment.prepareArtifact(
    { source: { kind: 'path', path: input.appPath } },
    { appIdentifierHint: input.app, signal },
  );
  try {
    return await deployPreparedAppleApp(host, device, { artifact }, signal);
  } finally {
    await artifact.cleanup();
  }
}

async function deployPreparedAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: DeployMaterializedAppInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  await installAppleApp(host, device, input.artifact.installablePath, signal);
  return {
    ...(input.artifact.bundleId ? { bundleId: input.artifact.bundleId } : {}),
    ...(input.artifact.appName ? { appName: input.artifact.appName } : {}),
    ...(input.artifact.bundleId ? { launchTarget: input.artifact.bundleId } : {}),
  };
}

async function installAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  installablePath: string,
  signal: AbortSignal,
): Promise<void> {
  await ensureAppleReady(host, device, signal);
  await runAppleTool(
    host,
    device.kind === 'simulator'
      ? {
          tool: 'simctl',
          args: scopeSimctlArgsForDevice(device, ['install', device.id, installablePath]),
        }
      : {
          tool: 'devicectl',
          args: ['device', 'install', 'app', '--device', device.id, installablePath],
          timeoutMs: IOS_DEVICE_INSTALL_TIMEOUT_MS,
        },
    signal,
    'Apple app install failed',
  );
}

async function uninstallAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  bundleId: string,
  signal: AbortSignal,
): Promise<void> {
  await ensureAppleReady(host, device, signal);
  await runAppleTool(
    host,
    device.kind === 'simulator'
      ? {
          tool: 'simctl',
          args: scopeSimctlArgsForDevice(device, ['uninstall', device.id, bundleId]),
        }
      : {
          tool: 'devicectl',
          args: ['device', 'uninstall', 'app', '--device', device.id, bundleId],
        },
    signal,
    `Apple app uninstall failed for ${bundleId}`,
    {
      tolerate: (result) =>
        isMissingAppErrorOutput(`${result.stdout}\n${result.stderr}`.toLowerCase()),
    },
  );
}

async function pushAppleNotification(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: PushNotificationInput,
  signal: AbortSignal,
): Promise<void> {
  if (device.kind !== 'simulator') {
    throw new AppError('UNSUPPORTED_OPERATION', 'Apple push notifications require a simulator');
  }
  await ensureAppleReady(host, device, signal);
  const payload = await host.temporaryFiles.create({
    prefix: 'agent-device-ios-push-',
    suffix: '.apns',
  });
  try {
    await payload.writeText(`${JSON.stringify(input.payload)}\n`);
    await runAppleTool(
      host,
      {
        tool: 'simctl',
        args: scopeSimctlArgsForDevice(device, ['push', device.id, input.appId, payload.path]),
      },
      signal,
      'Apple push notification failed',
    );
  } finally {
    await payload[Symbol.asyncDispose]();
  }
}

/**
 * The one request path this module uses to run a tolerated Apple tool call: it forces
 * `allowFailure`, then guards the result itself through `requireExecSuccess` so a non-zero
 * exit always throws the same COMMAND_FAILED shape as every other exec call site, with the
 * caller's curated message. A devicectl failure gets the same Developer Mode,
 * developer-disk-image, and pairing hints the other devicectl call sites attach. `tolerate`
 * lets a caller accept a specific non-zero result (uninstall's "already missing" case)
 * without losing that guard for every other outcome.
 */
async function runAppleTool(
  host: PlatformRuntimeHost,
  request: AppleToolRequest,
  signal: AbortSignal,
  message: string,
  options?: Readonly<{ tolerate?: (result: HostCommandResult) => boolean }>,
): Promise<HostCommandResult> {
  const result = await host.appleTools.run({ ...request, allowFailure: true }, signal);
  if (options?.tolerate?.(result)) return result;
  return requireExecSuccess(result, message, (failed) => ({
    cmd: 'xcrun',
    args: [request.tool, ...request.args],
    ...(request.tool === 'devicectl'
      ? {
          hint: resolveIosDevicectlHint(failed.stdout, failed.stderr) ?? IOS_DEVICECTL_DEFAULT_HINT,
        }
      : {}),
  }));
}

function appleDeployFact(device: DeviceInfo): RuntimeOperationFact {
  if (!isSupportedAppleDeploymentLeaf(device)) return unsupportedLeaf;
  if (device.kind !== 'simulator' && device.kind !== 'device') return unsupportedKind;
  if (device.kind === 'device' && device.iosPhysicalDeviceBackend === 'xctest') {
    return coreDeviceRequired;
  }
  return available;
}

function applePushFact(device: DeviceInfo): RuntimeOperationFact {
  if (!isSupportedAppleDeploymentLeaf(device)) return unsupportedLeaf;
  return device.kind === 'simulator' ? available : simulatorOnly;
}

function appleContainerJsonFact(device: DeviceInfo): RuntimeOperationFact {
  if (!isSupportedAppleDeploymentLeaf(device)) return unsupportedLeaf;
  return device.kind === 'simulator' || device.kind === 'device' ? available : unsupportedKind;
}

function isSupportedAppleDeploymentLeaf(device: DeviceInfo): boolean {
  return isIosFamily(device) && device.appleOs !== 'watchos';
}
