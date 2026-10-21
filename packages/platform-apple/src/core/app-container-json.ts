import {
  APP_CONTAINER_JSON_MAX_BYTES,
  checkAppContainerJsonPath,
  isBoundedAppContainerJsonObject,
  type AppContainerReadJsonResult,
} from '@agent-device/contracts/app-deployment-runtime';
import { createHash, randomUUID } from 'node:crypto';
import {
  createHostDirectory,
  hostFileLstat,
  makeHostTemporaryDirectory,
  readHostTextFile,
  removeHostPath,
  renameHostPath,
  resolveHostPath,
  writeHostTextFile,
  unlinkHostFile,
} from '@agent-device/host-kit/host-file';
import path from 'node:path';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails, type ExecResult } from '@agent-device/host-kit/command';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { runXcrun } from './tool-provider.ts';

const COPY_TIMEOUT_MS = 30_000;

export type AppleAppContainerJsonWrite = Readonly<{
  appId: string;
  containerPath: string;
  serializedValue: string;
}>;

export type AppleAppContainerJsonWriteResult = Readonly<{
  sha256: string;
  byteLength: number;
}>;

export type AppleAppContainerJsonDependencies = Readonly<{
  runXcrun: typeof runXcrun;
  withTemporaryText<Result>(
    value: string,
    operation: (pathname: string) => Promise<Result>,
  ): Promise<Result>;
  writeTextAtomicUnderRoot(
    containerRoot: string,
    containerPath: string,
    value: string,
    signal: AbortSignal,
  ): Promise<string>;
  readText(pathname: string): Promise<string>;
}>;

const defaultDependencies: AppleAppContainerJsonDependencies = Object.freeze({
  runXcrun,
  withTemporaryText: async (value, operation) => {
    const directory = await makeHostTemporaryDirectory('agent-device-app-config-');
    const pathname = path.join(directory, 'value.json');
    try {
      await writeHostTextFile(pathname, value, { flag: 'wx' });
      return await operation(pathname);
    } finally {
      await removeHostPath(directory);
    }
  },
  writeTextAtomicUnderRoot,
  readText: async (pathname) => {
    const status = await hostFileLstat(pathname);
    if (status.size > APP_CONTAINER_JSON_MAX_BYTES) {
      throw new AppError('COMMAND_FAILED', 'App-container JSON exceeds the 512 KiB limit', {
        reason: 'app_container_json_too_large',
      });
    }
    return await readHostTextFile(pathname);
  },
});

export async function writeTextAtomicUnderRoot(
  containerRoot: string,
  containerPath: string,
  value: string,
  signal: AbortSignal,
): Promise<string> {
  const resolvedRoot = await resolveHostPath(containerRoot);
  const components = containerPath.split('/');
  const filename = components.pop();
  if (filename === undefined) {
    throw new AppError('INVALID_ARGS', 'containerPath must name a JSON file');
  }
  const parentPath = await resolveRealDirectoryUnderRoot(resolvedRoot, components, true);
  const pathname = path.join(parentPath, filename);
  const temporaryPath = `${pathname}.agent-device-${randomUUID()}.tmp`;
  try {
    await writeHostTextFile(temporaryPath, value, { flag: 'wx' });
    signal.throwIfAborted();
    const revalidatedParent = await resolveRealDirectoryUnderRoot(resolvedRoot, components, false);
    if (revalidatedParent !== parentPath) {
      throw new AppError('COMMAND_FAILED', 'App container directory changed before publish');
    }
    await renameHostPath(temporaryPath, pathname);
    return pathname;
  } finally {
    await unlinkHostFile(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

export async function writeVerifiedAppleAppContainerJson(
  device: DeviceInfo,
  input: AppleAppContainerJsonWrite,
  signal: AbortSignal,
  dependencies: AppleAppContainerJsonDependencies = defaultDependencies,
): Promise<AppleAppContainerJsonWriteResult> {
  signal.throwIfAborted();
  requireSupportedDevice(device);
  const appId = requireText(input.appId, 'appId');
  const containerPath = requireContainerPath(input.containerPath);
  const expected = digest(input.serializedValue);
  const observed =
    device.kind === 'device'
      ? await writeAndReadPhysical(
          device,
          appId,
          containerPath,
          input.serializedValue,
          signal,
          dependencies,
        )
      : await writeAndReadSimulator(
          device,
          appId,
          containerPath,
          input.serializedValue,
          signal,
          dependencies,
        );
  signal.throwIfAborted();
  if (observed !== input.serializedValue) {
    throw new AppError('COMMAND_FAILED', 'App container JSON read-back did not match the write');
  }
  return expected;
}

export async function readAppleAppContainerJson(
  device: DeviceInfo,
  input: Readonly<{ appId: string; containerPath: string }>,
  signal: AbortSignal,
  dependencies: AppleAppContainerJsonDependencies = defaultDependencies,
): Promise<Omit<AppContainerReadJsonResult, 'appId' | 'containerPath'>> {
  signal.throwIfAborted();
  requireSupportedDevice(device);
  const appId = requireText(input.appId, 'appId');
  const containerPath = requireContainerPath(input.containerPath);
  const contents =
    device.kind === 'device'
      ? await dependencies.withTemporaryText('', async (destinationPath) => {
          await runDeviceCopy(
            device,
            'from',
            containerPath,
            destinationPath,
            appId,
            signal,
            dependencies,
          );
          return await dependencies.readText(destinationPath);
        })
      : await readSimulatorContainerJson(device, appId, containerPath, signal, dependencies);
  signal.throwIfAborted();
  const receipt = digest(contents);
  if (receipt.byteLength > APP_CONTAINER_JSON_MAX_BYTES) {
    throw new AppError('COMMAND_FAILED', 'App-container JSON exceeds the 512 KiB limit', {
      reason: 'app_container_json_too_large',
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new AppError('COMMAND_FAILED', 'App container file is not valid JSON');
  }
  if (!isBoundedAppContainerJsonObject(value)) {
    throw new AppError(
      'COMMAND_FAILED',
      'App container JSON must be an object with at most 128 nesting levels',
    );
  }
  return { ...receipt, value };
}

async function readSimulatorContainerJson(
  device: DeviceInfo,
  appId: string,
  containerPath: string,
  signal: AbortSignal,
  dependencies: AppleAppContainerJsonDependencies,
): Promise<string> {
  const root = await resolveSimulatorDataContainer(device, appId, signal, dependencies);
  const resolvedRoot = await resolveHostPath(root);
  const components = containerPath.split('/');
  const filename = components.pop()!;
  const parent = await resolveRealDirectoryUnderRoot(resolvedRoot, components, false);
  const pathname = path.join(parent, filename);
  const status = await hostFileLstat(pathname);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    (await resolveHostPath(pathname)) !== pathname
  ) {
    throw new AppError(
      'COMMAND_FAILED',
      'App container JSON must be a regular file inside its data container',
    );
  }
  signal.throwIfAborted();
  return await dependencies.readText(pathname);
}

async function writeAndReadPhysical(
  device: DeviceInfo,
  appId: string,
  containerPath: string,
  value: string,
  signal: AbortSignal,
  dependencies: AppleAppContainerJsonDependencies,
): Promise<string> {
  await dependencies.withTemporaryText(value, async (sourcePath) => {
    await runDeviceCopy(device, 'to', sourcePath, containerPath, appId, signal, dependencies);
  });
  return await dependencies.withTemporaryText('', async (destinationPath) => {
    await runDeviceCopy(
      device,
      'from',
      containerPath,
      destinationPath,
      appId,
      signal,
      dependencies,
    );
    return await dependencies.readText(destinationPath);
  });
}

async function runDeviceCopy(
  device: DeviceInfo,
  direction: 'to' | 'from',
  source: string,
  destination: string,
  appId: string,
  signal: AbortSignal,
  dependencies: AppleAppContainerJsonDependencies,
): Promise<void> {
  const result = await dependencies.runXcrun(
    [
      'devicectl',
      'device',
      'copy',
      direction,
      '--device',
      device.id,
      '--source',
      source,
      '--destination',
      destination,
      '--domain-type',
      'appDataContainer',
      '--domain-identifier',
      appId,
    ],
    { allowFailure: true, signal, timeoutMs: COPY_TIMEOUT_MS },
  );
  signal.throwIfAborted();
  requireSuccess(result, `Failed to copy app container JSON ${direction} the device`);
}

async function writeAndReadSimulator(
  device: DeviceInfo,
  appId: string,
  containerPath: string,
  value: string,
  signal: AbortSignal,
  dependencies: AppleAppContainerJsonDependencies,
): Promise<string> {
  const containerRoot = await resolveSimulatorDataContainer(device, appId, signal, dependencies);
  const pathname = await dependencies.writeTextAtomicUnderRoot(
    containerRoot,
    containerPath,
    value,
    signal,
  );
  signal.throwIfAborted();
  return await dependencies.readText(pathname);
}

async function resolveSimulatorDataContainer(
  device: DeviceInfo,
  appId: string,
  signal: AbortSignal,
  dependencies: AppleAppContainerJsonDependencies,
): Promise<string> {
  const result = await dependencies.runXcrun(
    buildSimctlArgsForDevice(device, ['get_app_container', device.id, appId, 'data']),
    { allowFailure: true, signal, timeoutMs: COPY_TIMEOUT_MS },
  );
  signal.throwIfAborted();
  requireSuccess(result, `Failed to resolve the Apple simulator data container for ${appId}`);
  const containerRoot = result.stdout.trim();
  if (!path.isAbsolute(containerRoot)) {
    throw new AppError('COMMAND_FAILED', 'simctl returned an invalid app data container path');
  }
  return path.resolve(containerRoot);
}

async function resolveRealDirectoryUnderRoot(
  resolvedRoot: string,
  components: readonly string[],
  createMissing: boolean,
): Promise<string> {
  let current = resolvedRoot;
  for (const component of components) {
    const candidate = path.join(current, component);
    const stats = await inspectContainerDirectory(candidate, createMissing);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new AppError('COMMAND_FAILED', 'App container JSON parent must be a real directory');
    }
    const realCandidate = await resolveHostPath(candidate);
    if (
      realCandidate !== candidate ||
      (realCandidate !== resolvedRoot && !realCandidate.startsWith(`${resolvedRoot}${path.sep}`))
    ) {
      throw new AppError('COMMAND_FAILED', 'App container JSON parent escapes its data container');
    }
    current = realCandidate;
  }
  return current;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isExistingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function requireSupportedDevice(device: DeviceInfo): void {
  if (
    !isIosFamily(device) ||
    device.appleOs === 'watchos' ||
    (device.kind !== 'simulator' && device.kind !== 'device')
  ) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'App container JSON writes require an Apple simulator or physical device',
    );
  }
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new AppError('INVALID_ARGS', `${name} must be a non-empty string`);
  }
  return value;
}

function digest(value: string): AppleAppContainerJsonWriteResult {
  return {
    sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
    byteLength: Buffer.byteLength(value, 'utf8'),
  };
}

function requireSuccess(result: ExecResult, message: string): void {
  if (result.exitCode === 0) return;
  throw new AppError('COMMAND_FAILED', message, execFailureDetails(result));
}

async function inspectContainerDirectory(candidate: string, createMissing: boolean) {
  try {
    return await hostFileLstat(candidate);
  } catch (error) {
    if (!isMissingPath(error) || !createMissing) throw error;
    try {
      await createHostDirectory(candidate);
    } catch (mkdirError) {
      if (!isExistingPath(mkdirError)) throw mkdirError;
    }
    return await hostFileLstat(candidate);
  }
}

function requireContainerPath(value: string): string {
  const checked = checkAppContainerJsonPath(value);
  if (!checked.valid) throw new AppError('INVALID_ARGS', checked.message);
  return checked.path;
}
