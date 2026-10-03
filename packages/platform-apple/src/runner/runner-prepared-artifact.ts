import {
  loadedAgentDevicePackageRoot,
  readAgentDeviceArtifactVersion,
} from './runner-package-root.ts';
import crypto from 'node:crypto';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  detectPreparedRunnerEnvironment,
  inspectRunnerXctestrunXml,
  type RunnerXctestrunInspection,
} from './runner-prepared-environment.ts';
import {
  assertPreparedPathUnchanged,
  capturePreparedPath,
  openPreparedProductsRoot,
  readPreparedFile,
  type PreparedPathSnapshot,
  type PreparedProductsRoot,
} from './runner-prepared-storage.ts';

declare const __AGENT_DEVICE_VERSION__: string;

type AppleRunnerStructuralIdentity = Readonly<{
  declaredTestHostContainerBundleId: string;
  sortedXctestrunProductReferences: readonly string[];
  targets: readonly Readonly<{
    declaredTestHostContainerBundleId: string;
    testHostPath: string;
    testBundlePath: string;
    sortedProductReferences: readonly string[];
  }>[];
}>;

export type AppleRunnerVerificationReceipt = Readonly<{
  schemaVersion: 1;
  agentDeviceVersion: string;
  base: Readonly<{
    relativePath: string;
    size: number;
    rawSha256: string;
    semanticSha256: string;
  }>;
  structuralIdentity: AppleRunnerStructuralIdentity;
  productsRootIdentity: Readonly<{ device: string; inode: string }>;
}>;

type InspectedRunnerXctestrun = Readonly<{
  productsRoot: PreparedProductsRoot;
  baseRelativePath: string;
  baseSnapshot: PreparedPathSnapshot;
  base: Buffer;
  baseSha256: string;
  inspection: RunnerXctestrunInspection;
  productSnapshots: readonly PreparedPathSnapshot[];
}>;

export function verifyAppleRunnerXctestrun(input: {
  productsRoot: string;
  baseXctestrunRelativePath: string;
  expectedBaseSha256: string;
  signal?: AbortSignal;
}): AppleRunnerVerificationReceipt {
  const inspected = inspectAppleRunnerXctestrun(input);
  verifyInspectedInputs(inspected, input.signal);
  return Object.freeze({
    schemaVersion: 1,
    agentDeviceVersion: resolveAgentDeviceVersion(),
    productsRootIdentity: productsRootIdentity(inspected.productsRoot),
    base: baseReceipt(inspected),
    structuralIdentity: structuralIdentityReceipt(inspected.inspection),
  });
}

function inspectAppleRunnerXctestrun(input: {
  productsRoot: string;
  baseXctestrunRelativePath: string;
  expectedBaseSha256: string;
  signal?: AbortSignal;
}): InspectedRunnerXctestrun {
  assertPreparationNotCanceled(input.signal);
  const productsRoot = openPreparedProductsRoot(input.productsRoot);
  const baseRelativePath = requireRelativePath(input.baseXctestrunRelativePath);
  const baseSnapshot = capturePreparedPath(productsRoot, baseRelativePath, true);
  const base = readPreparedFile(baseSnapshot);
  const baseSha256 = sha256(base);
  if (baseSha256 !== normalizeSha256(input.expectedBaseSha256)) {
    throw preparationError(
      'runner_preparation_base_changed',
      'XCTest runner base digest does not match the trusted manifest',
    );
  }
  if (detectPreparedRunnerEnvironment(base)) {
    throw preparationError(
      'runner_preparation_already_prepared',
      'XCTest runner base is already environment-prepared',
    );
  }
  const inspection = inspectRunnerXctestrunXml(base.toString('utf8'));
  assertPreparedPathUnchanged(baseSnapshot);
  const productSnapshots = assertReferencedProductsExist(
    productsRoot,
    inspection.unownedProductReferences,
    inspection.targets,
  );
  return Object.freeze({
    productsRoot,
    baseRelativePath,
    baseSnapshot,
    base,
    baseSha256,
    inspection,
    productSnapshots,
  });
}

function verifyInspectedInputs(inspected: InspectedRunnerXctestrun, signal?: AbortSignal): void {
  assertPreparationNotCanceled(signal);
  assertPreparedPathUnchanged(inspected.baseSnapshot);
  for (const snapshot of inspected.productSnapshots) assertPreparedPathUnchanged(snapshot);
}

function baseReceipt(inspected: InspectedRunnerXctestrun) {
  return Object.freeze({
    relativePath: inspected.baseRelativePath,
    size: inspected.base.length,
    rawSha256: inspected.baseSha256,
    semanticSha256: sha256(Buffer.from(inspected.inspection.semanticJson)),
  });
}

function productsRootIdentity(productsRoot: PreparedProductsRoot) {
  return Object.freeze({
    device: String(productsRoot.identity.device),
    inode: String(productsRoot.identity.inode),
  });
}

function structuralIdentityReceipt(
  inspection: Pick<
    RunnerXctestrunInspection,
    'declaredTestHostContainerBundleId' | 'productReferences' | 'targets'
  >,
): AppleRunnerStructuralIdentity {
  return Object.freeze({
    declaredTestHostContainerBundleId: inspection.declaredTestHostContainerBundleId,
    sortedXctestrunProductReferences: inspection.productReferences,
    targets: Object.freeze(
      inspection.targets.map((target) =>
        Object.freeze({
          declaredTestHostContainerBundleId: target.declaredTestHostContainerBundleId,
          testHostPath: target.testHostPath,
          testBundlePath: target.testBundlePath,
          sortedProductReferences: target.productReferences,
        }),
      ),
    ),
  });
}

function assertPreparationNotCanceled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw preparationError(
    'runner_preparation_canceled',
    'XCTest runner preparation was canceled',
    signal.reason,
  );
}

function requireRelativePath(value: string): string {
  const normalized = path.normalize(value.trim());
  if (
    !value.trim() ||
    path.isAbsolute(value) ||
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw preparationError(
      'runner_preparation_path_invalid',
      'XCTest runner path must stay relative to Products',
    );
  }
  return normalized;
}

function assertReferencedProductsExist(
  productsRoot: PreparedProductsRoot,
  unownedReferences: readonly string[],
  targets: readonly Readonly<{
    testHostPath: string;
    productReferences: readonly string[];
  }>[],
): readonly PreparedPathSnapshot[] {
  const snapshots: PreparedPathSnapshot[] = [];
  for (const reference of unownedReferences) {
    snapshots.push(captureProductPath(productsRoot, reference.slice('__TESTROOT__/'.length)));
  }
  for (const target of targets) {
    const hostRelativePath = target.testHostPath.slice('__TESTROOT__/'.length);
    snapshots.push(captureProductPath(productsRoot, hostRelativePath));
    for (const reference of target.productReferences) {
      if (reference.startsWith('__TESTROOT__/')) {
        snapshots.push(captureProductPath(productsRoot, reference.slice('__TESTROOT__/'.length)));
        continue;
      }
      const testHostRelativePath = reference.slice('__TESTHOST__/'.length);
      snapshots.push(
        captureProductPath(productsRoot, path.join(hostRelativePath, testHostRelativePath)),
      );
    }
  }
  return Object.freeze(snapshots);
}

function captureProductPath(
  productsRoot: PreparedProductsRoot,
  relativePath: string,
): PreparedPathSnapshot {
  try {
    return capturePreparedPath(productsRoot, relativePath, false);
  } catch (error) {
    throw preparationError(
      'runner_preparation_product_missing',
      'XCTest runner references a missing or unsafe product',
      error,
    );
  }
}

function normalizeSha256(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw preparationError(
      'runner_preparation_digest_invalid',
      'Expected XCTest runner digest must be lowercase SHA-256 hex',
    );
  }
  return normalized;
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function resolveAgentDeviceVersion(): string {
  return typeof __AGENT_DEVICE_VERSION__ === 'string'
    ? __AGENT_DEVICE_VERSION__
    : readAgentDeviceArtifactVersion(loadedAgentDevicePackageRoot(import.meta.url));
}

function preparationError(reason: string, message: string, cause?: unknown): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason,
    ...(cause === undefined ? {} : { cause: String(cause) }),
  });
}
