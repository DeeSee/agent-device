import { testFixture, type MutableCandidate } from './runner-local-artifact.fixtures.ts';
import { loadedAgentDevicePackageRoot } from '../runner-package-root.ts';
import { loadedAgentDeviceVersion } from '../runner-package-identity.ts';

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  copyRunnerArtifactTree,
  frozenRunnerArtifactTreeSha256,
  makeRunnerArtifactTreeRemovable,
  snapshotRunnerArtifactTree,
} from '../runner-local-artifact-storage.ts';
import {
  buildLocalAppleRunnerArtifact,
  buildLocalAppleRunnerArtifactWithEffects,
} from '../runner-local-artifact.ts';
import {
  decodeLocalAppleRunnerArtifactManifest,
  LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA,
  LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA_SHA256,
  parseLocalAppleRunnerArtifactManifest,
} from '../runner-local-artifact-manifest.ts';
import { materializeLocalAppleRunnerConfiguration } from '../runner-local-artifact-lease.ts';
import { verifyAppleRunnerXctestrun } from '../runner-prepared-artifact.ts';
import {
  captureRunnerBuildSources,
  captureLoadedProducerSources,
} from '../runner-local-artifact-source-set.ts';
import { createRunnerBuildArguments } from '../runner-local-artifact-effects.ts';
import {
  createLocalRunnerBuildInput,
  serializeLocalRunnerBuildRequestIdentity,
} from '../runner-local-artifact-request.ts';
import type {
  AppleRunnerArtifactBuildEffects,
  AppleRunnerArtifactBuildInput,
  AppleRunnerArtifactBuildSettings,
  LocalAppleRunnerWorkspace,
} from '../runner-local-artifact-contract.ts';
const {
  mockGetFreePort,
  fakeEffects,
  buildOptions,
  createSourceRoot,
  createInstalledSourceRoot,
  testWorkspaceFactory,
  persistentWorkspaceFactory,
  writePackageVersion,
  writeProducts,
  sha256,
} = testFixture;

test('emits one untrusted local candidate directly consumable after private copy', async () => {
  const sourceRoot = createSourceRoot();
  const checkoutRunnerTreeSha256 = captureRunnerBuildSources(sourceRoot).sha256;
  const outputParent = mkdtempForTestSync('agent-device-runner-output-');
  const buildCalls: AppleRunnerArtifactBuildInput[] = [];
  const effects = fakeEffects((input) => {
    buildCalls.push(input);
    writeProducts(input.derivedData, 'iphoneos');
  });

  const receipt = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(sourceRoot, outputParent, 'device', 'platform=iOS,id=private-device'),
    effects,
  );
  try {
    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0]).toMatchObject({
      destination: 'platform=iOS,id=private-device',
      variant: 'device',
    });
    expect(buildCalls[0]!.sourceRoot).not.toBe(sourceRoot);
    expect(buildCalls[0]!.sourceRoot).toContain('FrozenSource');
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      agentDeviceVersion: '9.8.7',
      variant: 'device',
      baseXctestrunRelativePath: expect.stringMatching(/^[^/]+\.xctestrun$/),
      artifactXctestrunRelativePath: expect.stringMatching(/^Build\/Products\/[^/]+\.xctestrun$/),
      publicationState: 'local_unpublished',
      activationEligible: false,
      cleanupComplete: true,
      producerClosureSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const manifestBytes = fs.readFileSync(path.join(receipt.artifactRoot, 'manifest.json'));
    expect(sha256(manifestBytes)).toBe(receipt.manifestSha256);
    expect(receipt.manifestSchemaSha256).toBe(LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA_SHA256);
    expect(sha256(Buffer.from(JSON.stringify(LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA)))).toBe(
      receipt.manifestSchemaSha256,
    );
    const decodedManifest = parseLocalAppleRunnerArtifactManifest(manifestBytes);
    expect(decodedManifest.schemaSha256).toBe(receipt.manifestSchemaSha256);
    expect(decodedManifest.source.checkoutRunnerTreeSha256).toBe(checkoutRunnerTreeSha256);
    expect(decodedManifest.source.frozenRunnerTreeSha256).not.toBe(checkoutRunnerTreeSha256);
    const manifestText = manifestBytes.toString('utf8');
    expect(manifestText).not.toContain('private-device');
    expect(JSON.parse(manifestText)).toMatchObject({
      publicationState: 'local_unpublished',
      activationEligible: false,
      producer: {
        closure: 'loaded producer module graph',
        closureSha256: receipt.producerClosureSha256,
      },
      source: {
        checkoutRunnerTreeSha256: checkoutRunnerTreeSha256,
        frozenRunnerTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      products: {
        baseXctestrunRelativePath: receipt.baseXctestrunRelativePath,
        artifactXctestrunRelativePath: receipt.artifactXctestrunRelativePath,
        knownReferencesResolvedAfterCopy: true,
      },
    });
    expect(manifestText).not.toContain('SECRET_TEAM');
    expect(manifestText).not.toContain('SECRET_CERTIFICATE');
    expect(manifestText).not.toContain('SECRET_PROFILE');
    expect(fs.existsSync(path.join(receipt.artifactRoot, 'COMPLETE'))).toBe(false);
    expect(fs.statSync(path.join(receipt.productsRoot, 'payload.bin')).nlink).toBe(1);

    const privateRoot = mkdtempForTestSync('agent-device-runner-private-copy-');
    const privateProducts = path.join(privateRoot, 'Products');
    fs.cpSync(receipt.productsRoot, privateProducts, { recursive: true });
    makeRunnerArtifactTreeRemovable(privateProducts);
    const verification = verifyAppleRunnerXctestrun({
      productsRoot: privateProducts,
      baseXctestrunRelativePath: receipt.baseXctestrunRelativePath,
      expectedBaseSha256: receipt.baseXctestrunSha256,
    });
    expect(verification.base.relativePath).toBe(receipt.baseXctestrunRelativePath);
  } finally {
    makeRunnerArtifactTreeRemovable(receipt.artifactRoot);
  }
});

test('freezes the Swift package dependency and refuses its mutation during the build', async () => {
  const sourceRoot = createSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-swift-package-');
  const manifest = 'apple/snapshot-presentation/Package.swift';
  const original = fs.readFileSync(path.join(sourceRoot, manifest), 'utf8');
  const effects = fakeEffects((input) => {
    expect(fs.readFileSync(path.join(input.sourceRoot, manifest), 'utf8')).toBe(original);
    expect(fs.statSync(path.join(input.sourceRoot, manifest)).mode & 0o222).toBe(0);
    fs.writeFileSync(path.join(sourceRoot, manifest), `${original}// changed package targets\n`);
    writeProducts(input.derivedData, 'iphonesimulator');
  });
  await expect(
    buildLocalAppleRunnerArtifactWithEffects(
      buildOptions(sourceRoot, outputParent, 'simulator'),
      effects,
    ),
  ).rejects.toMatchObject({ code: 'runner_source_changed' });
  expect(fs.readdirSync(outputParent)).toEqual([]);
});

test('materializes distinct private configurations without changing the reusable candidate', async () => {
  mockGetFreePort.mockClear();
  const sourceRoot = createInstalledSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-materialize-output-');
  const temporaryParent = mkdtempForTestSync('agent-device-runner-materialize-private-');
  const artifact = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(sourceRoot, outputParent, 'device'),
    fakeEffects((input) => {
      writeProducts(input.derivedData, 'iphoneos');
    }),
  );
  const before = snapshotRunnerArtifactTree(artifact.productsRoot, 'product');
  const workspaceFactory = testWorkspaceFactory(temporaryParent);

  const first = await materializeLocalAppleRunnerConfiguration({
    artifactRoot: artifact.artifactRoot,
    targetKind: 'device',
    workspaceFactory,
  });
  const second = await materializeLocalAppleRunnerConfiguration({
    artifactRoot: artifact.artifactRoot,
    targetKind: 'device',
    workspaceFactory,
  });

  let firstXctestrun = '';
  let secondXctestrun = '';
  await first.withConfiguration(async (configuration) => {
    firstXctestrun = configuration.iosXctestrunFile;
    expect(fs.existsSync(configuration.iosXctestrunFile)).toBe(true);
    expect(path.basename(configuration.iosXctestrunFile)).toBe(artifact.baseXctestrunRelativePath);
    expect(fs.readFileSync(configuration.iosXctestrunFile, 'utf8')).not.toContain(
      'AGENT_DEVICE_RUNNER_ENV_VERSION',
    );
    expect(fs.existsSync(configuration.iosXctestDerivedDataPath)).toBe(true);
    expect(fs.existsSync(configuration.iosXctestEnvDir)).toBe(true);
  });
  await second.withConfiguration(async (configuration) => {
    secondXctestrun = configuration.iosXctestrunFile;
  });
  expect(firstXctestrun).not.toBe(secondXctestrun);
  expect(mockGetFreePort).not.toHaveBeenCalled();
  expect(first.receipt).toMatchObject({
    kind: 'local_apple_runner_configuration_v2',
    agentDeviceVersion: loadedAgentDeviceVersion(),
    targetKind: 'device',
    manifestSha256: artifact.manifestSha256,
    productsContentSha256: artifact.productsContentSha256,
    baseXctestrunSha256: artifact.baseXctestrunSha256,
    runtimeEnvironment: 'per_runner_session_overlay_v1',
  });
  expect(snapshotRunnerArtifactTree(artifact.productsRoot, 'product')).toEqual(before);
  expect(
    fs.existsSync(path.join(artifact.productsRoot, 'AgentDeviceRunner.prepared.v1.xctestrun')),
  ).toBe(false);

  expect(await first.close()).toEqual({ kind: 'closed' });
  expect(await first.close()).toEqual({ kind: 'closed' });
  expect(await second.close()).toEqual({ kind: 'closed' });
  expect(fs.readdirSync(temporaryParent)).toEqual([]);
});

test('reopens one verified persistent workspace without changing runner identity', async () => {
  const sourceRoot = createInstalledSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-reopen-output-');
  const privateRoot = mkdtempForTestSync('agent-device-runner-reopen-private-');
  const artifact = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(sourceRoot, outputParent, 'device'),
    fakeEffects((input) => {
      writeProducts(input.derivedData, 'iphoneos');
    }),
  );
  const workspaceFactory = persistentWorkspaceFactory(privateRoot);

  const first = await materializeLocalAppleRunnerConfiguration({
    artifactRoot: artifact.artifactRoot,
    targetKind: 'device',
    workspaceFactory,
    reuseExistingWorkspace: true,
  });
  let firstConfiguration: unknown;
  await first.withConfiguration(async (configuration) => {
    firstConfiguration = configuration;
  });
  expect(await first.close()).toEqual({ kind: 'closed' });

  await expect(
    materializeLocalAppleRunnerConfiguration({
      artifactRoot: artifact.artifactRoot,
      targetKind: 'device',
      workspaceFactory,
    }),
  ).rejects.toMatchObject({ code: 'invalid_options' });

  const reopened = await materializeLocalAppleRunnerConfiguration({
    artifactRoot: artifact.artifactRoot,
    targetKind: 'device',
    workspaceFactory,
    reuseExistingWorkspace: true,
  });
  await reopened.withConfiguration(async (configuration) => {
    expect(configuration).toEqual(firstConfiguration);
  });
  expect(reopened.receipt).toEqual(first.receipt);
  expect(await reopened.close()).toEqual({ kind: 'closed' });

  const reusedPayload = path.join(privateRoot, 'Build/Products/payload.bin');
  fs.chmodSync(reusedPayload, 0o600);
  fs.writeFileSync(reusedPayload, 'changed');
  await expect(
    materializeLocalAppleRunnerConfiguration({
      artifactRoot: artifact.artifactRoot,
      targetKind: 'device',
      workspaceFactory,
      reuseExistingWorkspace: true,
    }),
  ).rejects.toMatchObject({ code: 'product_copy_changed' });
  makeRunnerArtifactTreeRemovable(privateRoot);
  fs.rmSync(privateRoot, { recursive: true });
});

test('revalidates the frozen product tree before every leased operation', async () => {
  const outputParent = mkdtempForTestSync('agent-device-runner-revalidate-output-');
  const privateRoot = mkdtempForTestSync('agent-device-runner-revalidate-private-');
  const artifact = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(createInstalledSourceRoot(), outputParent, 'device'),
    fakeEffects((input) => {
      writeProducts(input.derivedData, 'iphoneos');
    }),
  );
  const lease = await materializeLocalAppleRunnerConfiguration({
    artifactRoot: artifact.artifactRoot,
    targetKind: 'device',
    workspaceFactory: persistentWorkspaceFactory(privateRoot),
    reuseExistingWorkspace: true,
  });
  await lease.withConfiguration(async () => undefined);

  const payload = path.join(privateRoot, 'Build/Products/payload.bin');
  fs.chmodSync(payload, 0o600);
  fs.writeFileSync(payload, 'changed');
  let operationCalled = false;
  await expect(
    lease.withConfiguration(async () => {
      operationCalled = true;
    }),
  ).rejects.toMatchObject({ code: 'product_copy_changed' });
  expect(operationCalled).toBe(false);
  makeRunnerArtifactTreeRemovable(privateRoot);
  fs.rmSync(privateRoot, { recursive: true });
});

test('materialization refuses version, target, and cancellation before creating work roots', async () => {
  const outputParent = mkdtempForTestSync('agent-device-runner-materialize-refusal-output-');
  const temporaryParent = mkdtempForTestSync('agent-device-runner-materialize-refusal-private-');
  const workspaceCreations: string[] = [];
  const workspaceFactory = testWorkspaceFactory(temporaryParent, workspaceCreations);
  const current = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(createInstalledSourceRoot(), outputParent, 'device'),
    fakeEffects((input) => {
      writeProducts(input.derivedData, 'iphoneos');
    }),
  );
  const old = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(createSourceRoot('0.19.3'), outputParent, 'device'),
    fakeEffects((input) => {
      writeProducts(input.derivedData, 'iphoneos');
    }),
  );
  const sameVersionOtherSource = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(createSourceRoot(loadedAgentDeviceVersion()), outputParent, 'device'),
    fakeEffects((input) => {
      writeProducts(input.derivedData, 'iphoneos');
    }),
  );
  const canceled = new AbortController();
  canceled.abort('test cancellation');

  await expect(
    materializeLocalAppleRunnerConfiguration({
      artifactRoot: old.artifactRoot,
      targetKind: 'device',
      workspaceFactory,
    }),
  ).rejects.toMatchObject({ code: 'artifact_version_mismatch' });
  await expect(
    materializeLocalAppleRunnerConfiguration({
      artifactRoot: current.artifactRoot,
      targetKind: 'simulator',
      workspaceFactory,
    }),
  ).rejects.toMatchObject({ code: 'artifact_variant_mismatch' });
  await expect(
    materializeLocalAppleRunnerConfiguration({
      artifactRoot: current.artifactRoot,
      targetKind: 'device',
      workspaceFactory,
      signal: canceled.signal,
    }),
  ).rejects.toMatchObject({ code: 'materialization_canceled' });
  await expect(
    materializeLocalAppleRunnerConfiguration({
      artifactRoot: sameVersionOtherSource.artifactRoot,
      targetKind: 'device',
      workspaceFactory,
    }),
  ).rejects.toMatchObject({ code: 'artifact_source_mismatch' });
  expect(workspaceCreations).toEqual([]);
  expect(fs.readdirSync(temporaryParent)).toEqual([]);
});

test('materialization cancellation while creating a workspace performs no root loan', async () => {
  const outputParent = mkdtempForTestSync('agent-device-runner-workspace-cancel-output-');
  const artifact = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(createInstalledSourceRoot(), outputParent, 'device'),
    fakeEffects((input) => {
      writeProducts(input.derivedData, 'iphoneos');
    }),
  );
  let releaseWorkspace!: (workspace: LocalAppleRunnerWorkspace) => void;
  let enteredCreation!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredCreation = resolve;
  });
  let rootLoans = 0;
  const close = vi.fn(async () => ({ kind: 'closed' as const }));
  const workspace: LocalAppleRunnerWorkspace = {
    async withRoot<T>(): Promise<T> {
      rootLoans += 1;
      throw new Error('unexpected root loan');
    },
    close,
  };
  const cancellation = new AbortController();
  const materialization = materializeLocalAppleRunnerConfiguration({
    artifactRoot: artifact.artifactRoot,
    targetKind: 'device',
    workspaceFactory: {
      create: async () =>
        await new Promise((resolve) => {
          releaseWorkspace = resolve;
          enteredCreation();
        }),
    },
    signal: cancellation.signal,
  });
  await entered;
  cancellation.abort('test cancellation');
  releaseWorkspace(workspace);

  await expect(materialization).rejects.toMatchObject({ code: 'materialization_canceled' });
  expect(rootLoans).toBe(0);
  expect(close).toHaveBeenCalledOnce();
});

test('public candidate decoder rejects drift, extras, unsafe paths, and incoherent totals', async () => {
  const sourceRoot = createSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-manifest-decoder-');
  const receipt = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(sourceRoot, outputParent, 'simulator'),
    fakeEffects((input) => {
      writeProducts(input.derivedData, 'iphonesimulator');
    }),
  );
  try {
    const original = JSON.parse(
      fs.readFileSync(path.join(receipt.artifactRoot, 'manifest.json'), 'utf8'),
    ) as MutableCandidate;
    const mutations = [
      (manifest: MutableCandidate) => {
        manifest.unreviewed = true;
      },
      (manifest: MutableCandidate) => {
        manifest.schemaSha256 = '0'.repeat(64);
      },
      (manifest: MutableCandidate) => {
        manifest.products.entries.reverse();
      },
      (manifest: MutableCandidate) => {
        manifest.products.referencedProducts.push('../escape.app');
      },
      (manifest: MutableCandidate) => {
        manifest.products.byteCount += 1;
      },
      (manifest: MutableCandidate) => {
        manifest.products.contentSha256 = '0'.repeat(64);
      },
      (manifest: MutableCandidate) => {
        manifest.products.entries[0]!.unreviewed = true;
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(original);
      mutate(candidate);
      expect(() => decodeLocalAppleRunnerArtifactManifest(candidate)).toThrowError(
        expect.objectContaining({ code: 'manifest_invalid' }),
      );
    }
    expect(() => parseLocalAppleRunnerArtifactManifest('')).toThrowError(
      expect.objectContaining({ code: 'manifest_invalid' }),
    );
  } finally {
    makeRunnerArtifactTreeRemovable(receipt.artifactRoot);
  }
});

test('public candidate schema is recursively immutable at its fingerprint', () => {
  const nested = LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA.properties.source;
  expect(Object.isFrozen(LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA)).toBe(true);
  expect(Object.isFrozen(nested)).toBe(true);
  expect(Object.isFrozen(nested.required)).toBe(true);
  expect(() => (nested.required as unknown as string[]).push('unreviewed')).toThrow(TypeError);
  expect(sha256(Buffer.from(JSON.stringify(LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA)))).toBe(
    LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA_SHA256,
  );
});

test('frozen runner identity ignores empty directories but binds every file byte, path, and mode', () => {
  const root = mkdtempForTestSync('agent-device-runner-frozen-identity-');
  const source = path.join(root, 'Runner.swift');
  fs.writeFileSync(source, 'final class Runner {}\n', { mode: 0o644 });
  const original = frozenRunnerArtifactTreeSha256(root);

  const empty = path.join(root, 'configuration');
  fs.mkdirSync(empty);
  expect(frozenRunnerArtifactTreeSha256(root)).toBe(original);
  fs.rmdirSync(empty);
  expect(frozenRunnerArtifactTreeSha256(root)).toBe(original);

  fs.writeFileSync(source, 'final class ChangedRunner {}\n');
  expect(frozenRunnerArtifactTreeSha256(root)).not.toBe(original);
  fs.writeFileSync(source, 'final class Runner {}\n');

  const renamed = path.join(root, 'Renamed.swift');
  fs.renameSync(source, renamed);
  expect(frozenRunnerArtifactTreeSha256(root)).not.toBe(original);
  fs.renameSync(renamed, source);

  fs.chmodSync(source, 0o744);
  expect(frozenRunnerArtifactTreeSha256(root)).not.toBe(original);
});

test('device candidate decoder rejects a missing architecture identity', async () => {
  const sourceRoot = createSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-device-architecture-');
  const receipt = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(sourceRoot, outputParent, 'device'),
    fakeEffects((input) => {
      writeProducts(input.derivedData, 'iphoneos');
    }),
  );
  try {
    const candidate = JSON.parse(
      fs.readFileSync(path.join(receipt.artifactRoot, 'manifest.json'), 'utf8'),
    ) as MutableCandidate;
    candidate.build.publicSettings.architectures = null;
    expect(() => decodeLocalAppleRunnerArtifactManifest(candidate)).toThrowError(
      expect.objectContaining({ code: 'manifest_invalid' }),
    );
  } finally {
    makeRunnerArtifactTreeRemovable(receipt.artifactRoot);
  }
});

test('builds only from the frozen copy but refuses publication if checkout source changes', async () => {
  const sourceRoot = createSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-frozen-source-');
  let frozenSource = '';
  const effects = fakeEffects((input) => {
    frozenSource = fs.readFileSync(
      path.join(input.sourceRoot, 'apple/runner/AgentDeviceRunner/Runner.swift'),
      'utf8',
    );
    fs.appendFileSync(
      path.join(sourceRoot, 'apple/runner/AgentDeviceRunner/Runner.swift'),
      '// changed later',
    );
    writeProducts(input.derivedData, 'iphonesimulator');
  });

  await expect(
    buildLocalAppleRunnerArtifactWithEffects(
      buildOptions(sourceRoot, outputParent, 'simulator'),
      effects,
    ),
  ).rejects.toMatchObject({ code: 'runner_source_changed' });
  expect(frozenSource).toBe('final class Runner {}\n');
  expect(fs.readdirSync(outputParent)).toEqual([]);
});

test('refuses a toolchain identity change across the build effect', async () => {
  const sourceRoot = createSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-toolchain-change-');
  let probe = 0;
  const effects = {
    ...fakeEffects((input) => {
      writeProducts(input.derivedData, 'iphonesimulator');
    }),
    inspectToolchain: async (input: AppleRunnerArtifactBuildInput) => ({
      xcodeVersion: '26.5',
      xcodeBuild: probe++ === 0 ? '17F42' : '17F43',
      sdk: input.variant === 'device' ? ('iphoneos' as const) : ('iphonesimulator' as const),
      sdkVersion: '26.5',
      sdkBuild: '23F73',
    }),
  };

  await expect(
    buildLocalAppleRunnerArtifactWithEffects(
      buildOptions(sourceRoot, outputParent, 'simulator'),
      effects,
    ),
  ).rejects.toMatchObject({ code: 'toolchain_invalid' });
  expect(fs.readdirSync(outputParent)).toEqual([]);
});

test('fingerprints the actual loaded producer closure and compiled CLI loads dist', async () => {
  const sourceRoot = createSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-producer-change-');
  const effects = fakeEffects((input) => {
    writeProducts(input.derivedData, 'iphonesimulator');
  });
  const receipt = await buildLocalAppleRunnerArtifactWithEffects(
    buildOptions(sourceRoot, outputParent, 'simulator'),
    effects,
  );
  try {
    expect(receipt.producerClosureSha256).toBe(
      (
        await captureLoadedProducerSources(
          new URL('../runner-local-artifact.ts', import.meta.url).href,
        )
      ).sha256,
    );
    const checkoutRoot = loadedAgentDevicePackageRoot(import.meta.url);
    const launcher = fs.readFileSync(
      path.join(checkoutRoot, 'scripts/build-local-apple-runner-artifact.mjs'),
      'utf8',
    );
    expect(launcher).toContain('../dist/src/internal/build-local-apple-runner-artifact.js');
    expect(launcher).not.toContain('../src/');
  } finally {
    makeRunnerArtifactTreeRemovable(receipt.artifactRoot);
  }
});

test('fails closed if the frozen runner is mutated by the build effect', async () => {
  const sourceRoot = createSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-frozen-mutation-');
  const effects = fakeEffects((input) => {
    const runner = path.join(input.sourceRoot, 'apple/runner/AgentDeviceRunner/Runner.swift');
    fs.chmodSync(runner, 0o600);
    fs.appendFileSync(runner, '// injected mutation');
    writeProducts(input.derivedData, 'iphonesimulator');
  });
  await expect(
    buildLocalAppleRunnerArtifactWithEffects(
      buildOptions(sourceRoot, outputParent, 'simulator'),
      effects,
    ),
  ).rejects.toMatchObject({ code: 'runner_source_changed' });
  expect(fs.readdirSync(outputParent)).toEqual([]);
});

test('refuses symlinks and hardlinks in the built product tree', async () => {
  const cases = [
    ['symlink', (products: string) => fs.symlinkSync('payload.bin', path.join(products, 'alias'))],
    [
      'hardlink',
      (products: string) =>
        fs.linkSync(path.join(products, 'payload.bin'), path.join(products, 'alias')),
    ],
  ] as const;
  for (const [kind, poison] of cases) {
    const sourceRoot = createSourceRoot();
    const outputParent = mkdtempForTestSync(`agent-device-runner-${kind}-`);
    const effects = fakeEffects((input) => {
      const products = writeProducts(input.derivedData, 'iphonesimulator');
      poison(products);
    });
    await expect(
      buildLocalAppleRunnerArtifactWithEffects(
        buildOptions(sourceRoot, outputParent, 'simulator'),
        effects,
      ),
    ).rejects.toMatchObject({ code: `product_${kind}_refused` });
    expect(fs.readdirSync(outputParent)).toEqual([]);
  }
});

test('copies exact product directory modes independently of the process umask', () => {
  const sourceParent = mkdtempForTestSync('agent-device-runner-copy-source-');
  const destinationParent = mkdtempForTestSync('agent-device-runner-copy-destination-');
  const source = path.join(sourceParent, 'Products');
  const nested = path.join(source, 'ModeSensitive.app');
  const destination = path.join(destinationParent, 'Products');
  fs.mkdirSync(nested, { recursive: true });
  fs.chmodSync(nested, 0o775);
  fs.writeFileSync(path.join(nested, 'payload'), 'payload');

  const previousUmask = process.umask(0o077);
  try {
    copyRunnerArtifactTree(source, destination);
  } finally {
    process.umask(previousUmask);
  }

  expect(fs.statSync(path.join(destination, 'ModeSensitive.app')).mode & 0o777).toBe(0o775);
});

test('copies files before applying a read-only product directory mode', () => {
  const sourceParent = mkdtempForTestSync('agent-device-runner-copy-readonly-source-');
  const destinationParent = mkdtempForTestSync('agent-device-runner-copy-readonly-destination-');
  const source = path.join(sourceParent, 'Products');
  const nested = path.join(source, 'ReadOnly.framework');
  const destination = path.join(destinationParent, 'Products');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'payload'), 'payload');
  fs.chmodSync(nested, 0o555);

  const copiedNested = path.join(destination, 'ReadOnly.framework');
  try {
    copyRunnerArtifactTree(source, destination);
    expect(fs.readFileSync(path.join(copiedNested, 'payload'), 'utf8')).toBe('payload');
    expect(fs.statSync(copiedNested).mode & 0o777).toBe(0o555);
  } finally {
    fs.chmodSync(nested, 0o755);
    if (fs.existsSync(copiedNested)) fs.chmodSync(copiedNested, 0o755);
  }
});

test('canonical request identity covers destination and every environment value', () => {
  const sourceRoot = createSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-request-identity-');
  const options = buildOptions(sourceRoot, outputParent, 'device');
  const input = createLocalRunnerBuildInput(options, '/private/frozen', '/private/derived');
  const digest = sha256(serializeLocalRunnerBuildRequestIdentity(input));
  const differentDestination = createLocalRunnerBuildInput(
    { ...options, destination: 'platform=iOS,id=another-private-device' },
    '/private/frozen',
    '/private/derived',
  );
  const differentHome = createLocalRunnerBuildInput(
    { ...options, environment: { ...options.environment, HOME: '/different/private/home' } },
    '/private/frozen',
    '/private/derived',
  );
  const reorderedSettings = Object.fromEntries(
    Object.entries(options.settings).reverse(),
  ) as AppleRunnerArtifactBuildSettings;
  const reordered = createLocalRunnerBuildInput(
    { ...options, settings: reorderedSettings },
    '/private/frozen',
    '/private/derived',
  );
  expect(sha256(serializeLocalRunnerBuildRequestIdentity(differentDestination))).not.toBe(digest);
  expect(sha256(serializeLocalRunnerBuildRequestIdentity(differentHome))).not.toBe(digest);
  expect(sha256(serializeLocalRunnerBuildRequestIdentity(reordered))).toBe(digest);
});

test('simulator argv shares the ordinary build projection and preserves ad-hoc signing', () => {
  const options = buildOptions('/private/source', '/private/output', 'simulator');
  const input = createLocalRunnerBuildInput(options, '/private/frozen', '/private/derived');
  const args = createRunnerBuildArguments(input);
  expect(args).toEqual(
    expect.arrayContaining([
      '-maximum-concurrent-test-simulator-destinations',
      'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_ISOLATION_CANARY',
    ]),
  );
  expect(
    args.filter((argument) =>
      [
        'AD_HOC_CODE_SIGNING_ALLOWED=',
        'CODE_SIGNING_ALLOWED=',
        'CODE_SIGNING_REQUIRED=',
        'CODE_SIGN_IDENTITY=',
        'DEVELOPMENT_TEAM=',
        'PROVISIONING_PROFILE_SPECIFIER=',
      ].some((prefix) => argument.startsWith(prefix)),
    ),
  ).toEqual([]);
  expect(args.some((argument) => argument.includes('no_adhoc_codesign'))).toBe(false);
  expect(args.some((argument) => argument.includes('SECRET_'))).toBe(false);
});

test('device argv shares device concurrency and carries complete explicit signing', () => {
  const options = buildOptions('/private/source', '/private/output', 'device');
  const input = createLocalRunnerBuildInput(options, '/private/frozen', '/private/derived');
  const args = createRunnerBuildArguments(input);
  expect(args).toEqual(
    expect.arrayContaining([
      '-maximum-concurrent-test-device-destinations',
      'ARCHS=arm64',
      'DEVELOPMENT_TEAM=SECRET_TEAM',
      'CODE_SIGN_IDENTITY=SECRET_CERTIFICATE',
      'CODE_SIGN_STYLE=Manual',
      'AGENT_DEVICE_IOS_RUNNER_PROVISIONING_PROFILE=SECRET_PROFILE',
      'CODE_SIGNING_ALLOWED=YES',
      'CODE_SIGNING_REQUIRED=YES',
    ]),
  );
  expect(args.some((argument) => argument.startsWith('PROVISIONING_PROFILE_SPECIFIER='))).toBe(
    false,
  );
  expect(args).not.toContain('-allowProvisioningUpdates');
});

test('manual provisioning belongs only to the app and UI-test target configurations', () => {
  const project = fs.readFileSync(
    new URL(
      '../../../../../apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/project.pbxproj',
      import.meta.url,
    ),
    'utf8',
  );
  const configurations = [
    ...project.matchAll(
      /isa = XCBuildConfiguration;\s*buildSettings = \{([\s\S]*?)\n\s*\};\s*name = (Debug|Release);/g,
    ),
  ];
  expect(configurations).toHaveLength(6);
  const owners: string[] = [];
  for (const configuration of configurations) {
    const settings = configuration[1] ?? '';
    const bundle = /PRODUCT_BUNDLE_IDENTIFIER = "([^"\n]+)";/.exec(settings)?.[1];
    if (bundle === undefined) {
      expect(settings).not.toContain('PROVISIONING_PROFILE_SPECIFIER');
      continue;
    }
    expect(settings).toContain(
      'PROVISIONING_PROFILE_SPECIFIER = "$(AGENT_DEVICE_IOS_RUNNER_PROVISIONING_PROFILE)";',
    );
    owners.push(bundle);
  }
  expect(owners.sort()).toEqual([
    '$(AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID)',
    '$(AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID)',
    '$(AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID)',
    '$(AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID)',
  ]);
});

test.each([
  ['architectures', null],
  ['architectures', ''],
  ['developmentTeam', null],
  ['developmentTeam', ''],
  ['codeSignIdentity', null],
  ['codeSignIdentity', ''],
  ['codeSignStyle', null],
  ['codeSignStyle', 'Automatic'],
  ['provisioningProfileSpecifier', null],
  ['provisioningProfileSpecifier', ''],
  ['codeSigningAllowed', null],
  ['codeSigningAllowed', 'NO'],
  ['codeSigningRequired', null],
  ['codeSigningRequired', 'NO'],
] as const)(
  'device build refuses invalid %s before output or build effects',
  async (field, value) => {
    const sourceRoot = createSourceRoot();
    const outputParent = mkdtempForTestSync('agent-device-runner-signing-refusal-');
    const build = vi.fn<AppleRunnerArtifactBuildEffects['build']>();
    const options = buildOptions(sourceRoot, outputParent, 'device');

    await expect(
      buildLocalAppleRunnerArtifactWithEffects(
        {
          ...options,
          settings: { ...options.settings, [field]: value },
        },
        { ...fakeEffects(build), build },
      ),
    ).rejects.toMatchObject({ code: 'invalid_options' });
    expect(build).not.toHaveBeenCalled();
    expect(fs.readdirSync(outputParent)).toEqual([]);
  },
);

test('public provider refuses a runner source from another agent-device version before build', async () => {
  const sourceRoot = createSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-version-mismatch-');
  await expect(
    buildLocalAppleRunnerArtifact(buildOptions(sourceRoot, outputParent, 'device')),
  ).rejects.toMatchObject({ code: 'source_invalid' });
  expect(fs.readdirSync(outputParent)).toEqual([]);
});

test('public provider refuses modified runner source at the same agent-device version', async () => {
  const sourceRoot = createSourceRoot(loadedAgentDeviceVersion());
  const outputParent = mkdtempForTestSync('agent-device-runner-source-identity-mismatch-');
  await expect(
    buildLocalAppleRunnerArtifact(buildOptions(sourceRoot, outputParent, 'device')),
  ).rejects.toMatchObject({ code: 'source_invalid' });
  expect(fs.readdirSync(outputParent)).toEqual([]);
});

test('explicit loaded provider version mismatch performs zero build effects', async () => {
  const sourceRoot = createSourceRoot('0.19.3');
  const outputParent = mkdtempForTestSync('agent-device-runner-explicit-version-mismatch-');
  const build = vi.fn<AppleRunnerArtifactBuildEffects['build']>();
  await expect(
    buildLocalAppleRunnerArtifactWithEffects(
      buildOptions(sourceRoot, outputParent, 'device'),
      { ...fakeEffects(build), build },
      '0.20.10',
    ),
  ).rejects.toMatchObject({ code: 'source_invalid' });
  expect(build).not.toHaveBeenCalled();
  expect(fs.readdirSync(outputParent)).toEqual([]);
});

test('refuses source package version drift after admission', async () => {
  const sourceRoot = createSourceRoot();
  const outputParent = mkdtempForTestSync('agent-device-runner-version-drift-');
  const effects = fakeEffects((input) => {
    writePackageVersion(sourceRoot, '9.8.8');
    writeProducts(input.derivedData, 'iphonesimulator');
  });
  await expect(
    buildLocalAppleRunnerArtifactWithEffects(
      buildOptions(sourceRoot, outputParent, 'simulator'),
      effects,
    ),
  ).rejects.toMatchObject({ code: 'source_invalid' });
  expect(fs.readdirSync(outputParent)).toEqual([]);
});
