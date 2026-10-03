import {
  loadedAgentDeviceVersion,
  loadedAgentDeviceRunnerSourceSha256,
} from './runner-package-identity.ts';
import {
  captureLoadedProducerSources,
  assertLoadedProducerUnchanged,
  captureRunnerBuildSources,
  freezeRunnerBuildSources,
  frozenRunnerBuildSourcesSha256,
  assertRunnerSourceSetUnchanged,
} from './runner-local-artifact-source-set.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  AppleRunnerArtifactBuildError,
  type AppleRunnerArtifactBuildEffects,
  type AppleRunnerArtifactBuildInput,
  type LocalAppleRunnerArtifactOptions,
  type LocalAppleRunnerArtifactReceipt,
} from './runner-local-artifact-contract.ts';
import {
  decodeLocalAppleRunnerArtifactManifest,
  LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA_SHA256,
} from './runner-local-artifact-manifest.ts';
import { localAppleRunnerArtifactEffects } from './runner-local-artifact-effects.ts';
import {
  publishLocalRunnerCandidate,
  settleLocalRunnerWorkRoot,
} from './runner-local-artifact-publication.ts';
import {
  createLocalRunnerBuildInput,
  serializeLocalRunnerBuildRequestIdentity,
} from './runner-local-artifact-request.ts';
import {
  assertAgentDeviceArtifactVersion,
  validateLocalRunnerArtifactOptions,
} from './runner-local-artifact-source.ts';
import {
  copyRunnerArtifactTree,
  sha256,
  snapshotRunnerArtifactTree,
  type RunnerArtifactTreeSnapshot,
} from './runner-local-artifact-storage.ts';

export async function buildLocalAppleRunnerArtifact(
  options: LocalAppleRunnerArtifactOptions,
): Promise<LocalAppleRunnerArtifactReceipt> {
  return buildLocalAppleRunnerArtifactWithEffects(
    options,
    localAppleRunnerArtifactEffects,
    loadedAgentDeviceVersion(),
    loadedAgentDeviceRunnerSourceSha256(),
  );
}

/** @internal Provider test seam; not exported by the public SDK façade. */
export async function buildLocalAppleRunnerArtifactWithEffects(
  options: LocalAppleRunnerArtifactOptions,
  effects: AppleRunnerArtifactBuildEffects,
  expectedAgentDeviceVersion?: string,
  expectedRunnerSourceSha256?: string,
): Promise<LocalAppleRunnerArtifactReceipt> {
  try {
    return await buildLocalAppleRunnerArtifactUnchecked(
      options,
      effects,
      expectedAgentDeviceVersion,
      expectedRunnerSourceSha256,
    );
  } catch (error) {
    if (error instanceof AppleRunnerArtifactBuildError) throw error;
    throw new AppleRunnerArtifactBuildError(
      'publication_failed',
      'Unable to build the local Apple runner artifact',
      error,
    );
  }
}

async function buildLocalAppleRunnerArtifactUnchecked(
  options: LocalAppleRunnerArtifactOptions,
  effects: AppleRunnerArtifactBuildEffects,
  expectedAgentDeviceVersion?: string,
  expectedRunnerSourceSha256?: string,
): Promise<LocalAppleRunnerArtifactReceipt> {
  const input = validateLocalRunnerArtifactOptions(options, expectedAgentDeviceVersion);
  const agentDeviceVersion = input.agentDeviceVersion;
  const producerClosure = await captureLoadedProducerSources(import.meta.url);
  const checkoutRunnerTree = captureRunnerBuildSources(input.sourceRoot);
  if (
    expectedRunnerSourceSha256 !== undefined &&
    frozenRunnerBuildSourcesSha256(checkoutRunnerTree) !== expectedRunnerSourceSha256
  ) {
    throw new AppleRunnerArtifactBuildError(
      'source_invalid',
      'Apple runner source does not match the loaded agent-device package',
    );
  }
  const workRoot = fs.mkdtempSync(path.join(input.outputParent, '.agent-device-runner-build-'));
  const frozenSource = path.join(workRoot, 'FrozenSource');
  const derivedData = path.join(workRoot, 'DerivedData');
  const stageRoot = path.join(workRoot, 'artifact');
  let published = false;
  try {
    const runnerTree = freezeRunnerBuildSources(checkoutRunnerTree, frozenSource);
    const frozenRunnerSourceSha256 = frozenRunnerBuildSourcesSha256(runnerTree);
    const buildInput = createLocalRunnerBuildInput(input, frozenSource, derivedData);
    const toolchain = await inspectToolchain(effects, buildInput);
    await runBuild(effects, buildInput);
    const toolchainAfterBuild = await inspectToolchain(effects, buildInput);
    if (JSON.stringify(toolchainAfterBuild) !== JSON.stringify(toolchain)) {
      throw new AppleRunnerArtifactBuildError(
        'toolchain_invalid',
        'Xcode or SDK identity changed while the runner was built',
      );
    }
    await assertLoadedProducerUnchanged(producerClosure);
    assertRunnerSourceSetUnchanged(checkoutRunnerTree, 'checkout runner source');
    assertRunnerSourceSetUnchanged(runnerTree, 'frozen runner source');

    const sourceProducts = path.join(derivedData, 'Build/Products');
    const sourceXctestrun = findXctestrun(
      snapshotRunnerArtifactTree(sourceProducts, 'product').entries,
      input.variant,
    );
    fs.mkdirSync(path.join(stageRoot, 'Build'), { recursive: true, mode: 0o700 });
    const stagedProducts = path.join(stageRoot, 'Build/Products');
    copyRunnerArtifactTree(sourceProducts, stagedProducts);
    const referencedProducts = await validateKnownReferencesAfterCopy(
      effects,
      stagedProducts,
      path.join(stagedProducts, sourceXctestrun),
    );
    await assertLoadedProducerUnchanged(producerClosure);
    assertRunnerSourceSetUnchanged(checkoutRunnerTree, 'checkout runner source');
    assertRunnerSourceSetUnchanged(runnerTree, 'frozen runner source');
    const products = snapshotRunnerArtifactTree(stagedProducts, 'product');
    const baseXctestrunRelativePath = sourceXctestrun;
    const artifactXctestrunRelativePath = path.join('Build/Products', sourceXctestrun);
    const baseXctestrunSha256 = products.entries.find(
      (entry) => entry.kind === 'file' && entry.path === sourceXctestrun,
    )?.sha256;
    if (!baseXctestrunSha256) {
      throw new AppleRunnerArtifactBuildError(
        'xctestrun_invalid',
        'Relocated xctestrun is missing from the sealed product tree',
      );
    }
    const manifest = decodeLocalAppleRunnerArtifactManifest({
      format: 'agent-device-apple-runner-artifact-v1',
      schemaVersion: 1,
      schemaSha256: LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA_SHA256,
      publicationState: 'local_unpublished',
      activationEligible: false,
      agentDeviceVersion,
      variant: input.variant,
      producer: {
        closure: 'loaded producer module graph',
        closureSha256: producerClosure.sha256,
      },
      source: {
        checkoutRunnerTreeSha256: checkoutRunnerTree.sha256,
        frozenRunnerTreeSha256: frozenRunnerSourceSha256,
      },
      build: {
        action: 'build-for-testing',
        destinationClass: input.variant,
        publicSettings: {
          appBundleId: buildInput.settings.appBundleId,
          testBundleId: buildInput.settings.testBundleId,
          architectures: buildInput.settings.architectures,
        },
        closedRequestSha256: sha256(serializeLocalRunnerBuildRequestIdentity(buildInput)),
      },
      toolchain,
      products: {
        rootRelativePath: 'Build/Products',
        baseXctestrunRelativePath,
        artifactXctestrunRelativePath,
        baseXctestrunSha256,
        knownReferencesResolvedAfterCopy: true,
        referencedProducts,
        contentSha256: products.sha256,
        fileCount: products.fileCount,
        byteCount: products.byteCount,
        entries: products.entries.map((entry) => ({
          ...entry,
          path: path.join('Build/Products', entry.path),
        })),
      },
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const manifestSha256 = sha256(manifestBytes);
    assertAgentDeviceArtifactVersion(input.sourceRoot, agentDeviceVersion);
    await assertLoadedProducerUnchanged(producerClosure);
    assertRunnerSourceSetUnchanged(checkoutRunnerTree, 'checkout runner source');
    assertRunnerSourceSetUnchanged(runnerTree, 'frozen runner source');
    assertTreeUnchanged(stagedProducts, products, 'staged product tree', 'product');
    const artifactRoot = publishLocalRunnerCandidate({
      outputParent: input.outputParent,
      variant: input.variant,
      stageRoot,
      manifestBytes,
      manifestSha256,
      productsRoot: stagedProducts,
      expectedProductsSha256: products.sha256,
    });
    published = true;
    const cleanupComplete = settleLocalRunnerWorkRoot(workRoot);
    return Object.freeze({
      schemaVersion: 1,
      agentDeviceVersion,
      variant: input.variant,
      artifactRoot,
      productsRoot: path.join(artifactRoot, 'Build/Products'),
      baseXctestrunRelativePath,
      artifactXctestrunRelativePath,
      baseXctestrunSha256,
      productsContentSha256: products.sha256,
      producerClosureSha256: producerClosure.sha256,
      checkoutRunnerTreeSha256: checkoutRunnerTree.sha256,
      frozenRunnerTreeSha256: frozenRunnerSourceSha256,
      manifestSchemaSha256: LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA_SHA256,
      manifestSha256,
      publicationState: 'local_unpublished',
      activationEligible: false,
      cleanupComplete,
    });
  } finally {
    if (!published) settleLocalRunnerWorkRoot(workRoot);
  }
}

/** @internal Shared by the local artifact materializer. */

function assertTreeUnchanged(
  root: string,
  expected: RunnerArtifactTreeSnapshot,
  label: string,
  role: 'source' | 'product' = 'source',
): void {
  if (snapshotRunnerArtifactTree(root, role).sha256 !== expected.sha256) {
    throw new AppleRunnerArtifactBuildError(
      role === 'source' ? 'runner_source_changed' : 'product_copy_changed',
      `The ${label} changed while the local runner candidate was built`,
    );
  }
}

function findXctestrun(
  entries: readonly { kind: 'directory' | 'file'; path: string }[],
  variant: 'device' | 'simulator',
): string {
  const marker = variant === 'device' ? 'iphoneos' : 'iphonesimulator';
  const matches = entries.filter(
    (entry) =>
      entry.kind === 'file' && entry.path.endsWith('.xctestrun') && entry.path.includes(marker),
  );
  if (matches.length !== 1) {
    throw new AppleRunnerArtifactBuildError(
      'xctestrun_missing',
      `Expected exactly one ${marker} xctestrun, found ${matches.length}`,
    );
  }
  return matches[0]!.path;
}

async function validateKnownReferencesAfterCopy(
  effects: AppleRunnerArtifactBuildEffects,
  productsRoot: string,
  xctestrunPath: string,
): Promise<readonly string[]> {
  let resolved: readonly string[] | null;
  try {
    resolved = await effects.validateXctestrun(xctestrunPath);
  } catch (error) {
    throw new AppleRunnerArtifactBuildError(
      'xctestrun_invalid',
      'Unable to inspect the relocated xctestrun',
      error,
    );
  }
  if (!resolved?.length) {
    throw new AppleRunnerArtifactBuildError(
      'xctestrun_invalid',
      'Relocated xctestrun has missing products',
    );
  }
  return Object.freeze(
    resolved
      .map((product) => {
        const relativePath = path.relative(productsRoot, path.resolve(product));
        if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
          throw new AppleRunnerArtifactBuildError(
            'xctestrun_invalid',
            'Relocated xctestrun references a product outside Build/Products',
          );
        }
        return relativePath;
      })
      .sort(),
  );
}

async function inspectToolchain(
  effects: AppleRunnerArtifactBuildEffects,
  input: AppleRunnerArtifactBuildInput,
): Promise<Awaited<ReturnType<AppleRunnerArtifactBuildEffects['inspectToolchain']>>> {
  try {
    return await effects.inspectToolchain(input);
  } catch (error) {
    if (error instanceof AppleRunnerArtifactBuildError) throw error;
    throw new AppleRunnerArtifactBuildError(
      'toolchain_invalid',
      'Unable to identify the runner build toolchain',
      error,
    );
  }
}

async function runBuild(
  effects: AppleRunnerArtifactBuildEffects,
  input: AppleRunnerArtifactBuildInput,
): Promise<void> {
  try {
    await effects.build(input);
  } catch (error) {
    if (error instanceof AppleRunnerArtifactBuildError) throw error;
    throw new AppleRunnerArtifactBuildError(
      'build_failed',
      'Runner build-for-testing failed',
      error,
    );
  }
}
