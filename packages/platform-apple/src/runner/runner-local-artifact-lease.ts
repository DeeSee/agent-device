import {
  readStableRunnerFile,
  copyRunnerArtifactTree,
  freezeRunnerArtifactTree,
  frozenRunnerArtifactEntryMode,
  sha256,
  snapshotRunnerArtifactTree,
} from './runner-local-artifact-storage.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  AppleRunnerArtifactBuildError,
  type AppleRunnerArtifactVariant,
  type LocalAppleRunnerArtifactManifest,
  type LocalAppleRunnerConfiguration,
  type LocalAppleRunnerConfigurationLease,
  type LocalAppleRunnerWorkspace,
  type LocalAppleRunnerWorkspaceFactory,
} from './runner-local-artifact-contract.ts';
import {
  loadedAgentDeviceRunnerSourceSha256,
  loadedAgentDeviceVersion,
} from './runner-package-identity.ts';
import { parseLocalAppleRunnerArtifactManifest } from './runner-local-artifact-manifest.ts';
import { verifyAppleRunnerXctestrun } from './runner-prepared-artifact.ts';

type DirectoryIdentity = Readonly<{ device: bigint; inode: bigint }>;

export async function materializeLocalAppleRunnerConfiguration(input: {
  artifactRoot: string;
  targetKind: AppleRunnerArtifactVariant;
  workspaceFactory: LocalAppleRunnerWorkspaceFactory;
  /** Reopen only after the complete persistent workspace is re-verified. */
  reuseExistingWorkspace?: boolean;
  signal?: AbortSignal;
}): Promise<LocalAppleRunnerConfigurationLease> {
  assertNotCanceled(input.signal);
  const artifactRoot = requireDirectory(input.artifactRoot, 'Local artifact root');
  const artifactIdentity = directoryIdentity(artifactRoot);
  const manifestPath = path.join(artifactRoot, 'manifest.json');
  const initialManifestBytes = readRegularFile(manifestPath);
  const manifest = parseLocalAppleRunnerArtifactManifest(initialManifestBytes);
  admitManifest(manifest, input.targetKind);
  const sourceProducts = path.join(artifactRoot, manifest.products.rootRelativePath);
  assertProductsMatchManifest(sourceProducts, manifest);
  const preparedProducts = preparedProductIdentity(manifest);
  assertArtifactUnchanged(artifactRoot, artifactIdentity, manifestPath, initialManifestBytes);
  assertNotCanceled(input.signal);

  let workspace: LocalAppleRunnerWorkspace;
  try {
    workspace = await input.workspaceFactory.create();
  } catch (error) {
    throw new AppleRunnerArtifactBuildError(
      'invalid_options',
      'Unable to create a private Apple runner workspace',
      error,
    );
  }
  try {
    assertNotCanceled(input.signal);
    const verification = await workspace.withRoot(async (workRoot) => {
      assertNotCanceled(input.signal);
      const privateRoot = requireDirectory(workRoot, 'Private workspace root');
      const existing = fs.readdirSync(privateRoot).length !== 0;
      if (existing && input.reuseExistingWorkspace !== true) {
        throw new AppleRunnerArtifactBuildError(
          'invalid_options',
          'Private Apple runner workspace must be empty',
        );
      }
      const productsRoot = path.join(privateRoot, 'Build/Products');
      if (existing) {
        assertReusableWorkspaceLayout(privateRoot);
        assertProductsMatchIdentity(productsRoot, preparedProducts);
      } else {
        fs.mkdirSync(path.dirname(productsRoot), { recursive: true, mode: 0o700 });
        copyRunnerArtifactTree(sourceProducts, productsRoot);
        fs.mkdirSync(path.join(privateRoot, 'DerivedData'), { mode: 0o700 });
        fs.mkdirSync(path.join(privateRoot, 'Environment'), { mode: 0o700 });
        assertProductsMatchManifest(productsRoot, manifest);
        freezeRunnerArtifactTree(productsRoot, 'installable');
        assertProductsMatchIdentity(productsRoot, preparedProducts);
      }
      assertArtifactUnchanged(artifactRoot, artifactIdentity, manifestPath, initialManifestBytes);
      assertProductsMatchManifest(sourceProducts, manifest);
      assertNotCanceled(input.signal);
      return verifyAppleRunnerXctestrun({
        productsRoot,
        baseXctestrunRelativePath: manifest.products.baseXctestrunRelativePath,
        expectedBaseSha256: manifest.products.baseXctestrunSha256,
        signal: input.signal,
      });
    });
    assertNotCanceled(input.signal);
    return Object.freeze({
      receipt: Object.freeze({
        kind: 'local_apple_runner_configuration_v2',
        agentDeviceVersion: manifest.agentDeviceVersion,
        targetKind: manifest.variant,
        manifestSha256: sha256(initialManifestBytes),
        productsContentSha256: manifest.products.contentSha256,
        baseXctestrunSha256: verification.base.rawSha256,
        runtimeEnvironment: 'per_runner_session_overlay_v1',
        fileCount: manifest.products.fileCount,
        byteCount: manifest.products.byteCount,
      }),
      async withConfiguration<T>(
        operation: (configuration: LocalAppleRunnerConfiguration) => Promise<T>,
      ): Promise<T> {
        return await workspace.withRoot(async (workRoot) => {
          assertNotCanceled(input.signal);
          const privateRoot = requireDirectory(workRoot, 'Private workspace root');
          assertReusableWorkspaceLayout(privateRoot);
          const productsRoot = path.join(privateRoot, 'Build/Products');
          assertProductsMatchIdentity(productsRoot, preparedProducts);
          const currentVerification = verifyAppleRunnerXctestrun({
            productsRoot,
            baseXctestrunRelativePath: manifest.products.baseXctestrunRelativePath,
            expectedBaseSha256: manifest.products.baseXctestrunSha256,
            signal: input.signal,
          });
          return await operation(
            Object.freeze({
              iosXctestrunFile: path.join(productsRoot, currentVerification.base.relativePath),
              iosXctestDerivedDataPath: path.join(privateRoot, 'DerivedData'),
              iosXctestEnvDir: path.join(privateRoot, 'Environment'),
            }),
          );
        });
      },
      close: async () => await workspace.close(),
    });
  } catch (error) {
    const failure = input.signal?.aborted
      ? new AppleRunnerArtifactBuildError(
          'materialization_canceled',
          'Local Apple runner materialization was canceled',
          input.signal.reason,
        )
      : error;
    const cleanup = await workspace.close();
    if (cleanup.kind !== 'closed') {
      throw new AppleRunnerArtifactBuildError(
        'materialization_cleanup_unresolved',
        'Local Apple runner materialization failed and its private workspace could not be closed',
        failure,
      );
    }
    throw failure;
  }
}

function assertReusableWorkspaceLayout(root: string): void {
  const expected = ['Build', 'DerivedData', 'Environment'];
  const actual = fs.readdirSync(root).sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new AppleRunnerArtifactBuildError(
      'invalid_options',
      'Reusable Apple runner workspace has an unexpected layout',
    );
  }
  requireDirectory(path.join(root, 'Build'), 'Reusable Build root');
  requireDirectory(path.join(root, 'Build/Products'), 'Reusable Products root');
  requireDirectory(path.join(root, 'DerivedData'), 'Reusable DerivedData root');
  requireDirectory(path.join(root, 'Environment'), 'Reusable Environment root');
}

function admitManifest(
  manifest: LocalAppleRunnerArtifactManifest,
  targetKind: AppleRunnerArtifactVariant,
): void {
  const currentVersion = loadedAgentDeviceVersion();
  if (manifest.agentDeviceVersion !== currentVersion) {
    throw new AppleRunnerArtifactBuildError(
      'artifact_version_mismatch',
      `Runner artifact version ${manifest.agentDeviceVersion} does not match agent-device ${currentVersion}`,
    );
  }
  if (manifest.variant !== targetKind) {
    throw new AppleRunnerArtifactBuildError(
      'artifact_variant_mismatch',
      `Runner artifact variant ${manifest.variant} does not match target ${targetKind}`,
    );
  }
  if (manifest.source.frozenRunnerTreeSha256 !== loadedAgentDeviceRunnerSourceSha256()) {
    throw new AppleRunnerArtifactBuildError(
      'artifact_source_mismatch',
      'Runner artifact source does not match the loaded agent-device package',
    );
  }
}

function assertProductsMatchManifest(
  productsRoot: string,
  manifest: LocalAppleRunnerArtifactManifest,
): void {
  const snapshot = snapshotRunnerArtifactTree(productsRoot, 'product');
  if (
    snapshot.sha256 !== manifest.products.contentSha256 ||
    snapshot.fileCount !== manifest.products.fileCount ||
    snapshot.byteCount !== manifest.products.byteCount
  ) {
    throw new AppleRunnerArtifactBuildError(
      'product_copy_changed',
      'Runner product tree does not match its local artifact manifest',
    );
  }
}

type ProductIdentity = Readonly<{
  sha256: string;
  fileCount: number;
  byteCount: number;
}>;

function preparedProductIdentity(manifest: LocalAppleRunnerArtifactManifest): ProductIdentity {
  const entries = manifest.products.entries
    .map((entry) => {
      const relativePath = path.relative(manifest.products.rootRelativePath, entry.path);
      if (
        !relativePath ||
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        throw new AppleRunnerArtifactBuildError(
          'manifest_invalid',
          'Runner product manifest contains a path outside Build/Products',
        );
      }
      return {
        ...entry,
        path: relativePath,
        mode: frozenRunnerArtifactEntryMode(entry, 'installable'),
      };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return Object.freeze({
    sha256: sha256(Buffer.from(JSON.stringify(entries))),
    fileCount: manifest.products.fileCount,
    byteCount: manifest.products.byteCount,
  });
}

function assertProductsMatchIdentity(productsRoot: string, expected: ProductIdentity): void {
  const snapshot = snapshotRunnerArtifactTree(productsRoot, 'product');
  if (
    snapshot.sha256 !== expected.sha256 ||
    snapshot.fileCount !== expected.fileCount ||
    snapshot.byteCount !== expected.byteCount
  ) {
    throw new AppleRunnerArtifactBuildError(
      'product_copy_changed',
      'Prepared runner product tree no longer matches its attested identity',
    );
  }
}

function assertArtifactUnchanged(
  artifactRoot: string,
  expectedIdentity: DirectoryIdentity,
  manifestPath: string,
  expectedManifest: Buffer,
): void {
  if (!sameDirectoryIdentity(artifactRoot, expectedIdentity)) {
    throw new AppleRunnerArtifactBuildError(
      'product_copy_changed',
      'Local runner artifact root changed during materialization',
    );
  }
  if (!readRegularFile(manifestPath).equals(expectedManifest)) {
    throw new AppleRunnerArtifactBuildError(
      'product_copy_changed',
      'Local runner artifact manifest changed during materialization',
    );
  }
}

function requireDirectory(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppleRunnerArtifactBuildError('invalid_options', `${label} must be a path`);
  }
  const resolved = path.resolve(value);
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('not a real directory');
  } catch (error) {
    throw new AppleRunnerArtifactBuildError(
      'invalid_options',
      `${label} must be an existing real directory`,
      error,
    );
  }
  return resolved;
}

function readRegularFile(filePath: string): Buffer {
  try {
    return readStableRunnerFile(filePath, (stat) => {
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe file');
    });
  } catch (error) {
    throw new AppleRunnerArtifactBuildError(
      'manifest_invalid',
      'Local runner artifact manifest is missing or unsafe',
      error,
    );
  }
}

function directoryIdentity(directory: string): DirectoryIdentity {
  const stat = fs.lstatSync(directory, { bigint: true });
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function sameDirectoryIdentity(directory: string, expected: DirectoryIdentity): boolean {
  try {
    const stat = fs.lstatSync(directory, { bigint: true });
    return (
      !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      stat.dev === expected.device &&
      stat.ino === expected.inode
    );
  } catch {
    return false;
  }
}

function assertNotCanceled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new AppleRunnerArtifactBuildError(
    'materialization_canceled',
    'Local Apple runner materialization was canceled',
    signal.reason,
  );
}
