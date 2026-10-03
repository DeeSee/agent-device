export {
  verifyAppleRunnerXctestrun,
  type AppleRunnerVerificationReceipt,
} from './runner/runner-prepared-artifact.ts';
export async function buildLocalAppleRunnerArtifact(
  options: import('./runner/runner-local-artifact-contract.ts').LocalAppleRunnerArtifactOptions,
): Promise<import('./runner/runner-local-artifact-contract.ts').LocalAppleRunnerArtifactReceipt> {
  await import('./core/runner-client.ts');
  const { buildLocalAppleRunnerArtifact: build } =
    await import('./runner/runner-local-artifact.ts');
  return await build(options);
}
export async function materializeLocalAppleRunnerConfiguration(
  ...args: Parameters<
    typeof import('./runner/runner-local-artifact-lease.ts').materializeLocalAppleRunnerConfiguration
  >
): Promise<
  Awaited<
    ReturnType<
      typeof import('./runner/runner-local-artifact-lease.ts').materializeLocalAppleRunnerConfiguration
    >
  >
> {
  const { materializeLocalAppleRunnerConfiguration: materialize } =
    await import('./runner/runner-local-artifact-lease.ts');
  return await materialize(...args);
}
export {
  decodeLocalAppleRunnerArtifactManifest,
  LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA,
  LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA_SHA256,
  parseLocalAppleRunnerArtifactManifest,
} from './runner/runner-local-artifact-manifest.ts';
export {
  AppleRunnerArtifactBuildError,
  type AppleRunnerArtifactBuildEnvironment,
  type AppleRunnerArtifactBuildSettings,
  type AppleRunnerArtifactVariant,
  type LocalAppleRunnerArtifactOptions,
  type LocalAppleRunnerArtifactManifest,
  type LocalAppleRunnerArtifactManifestEntry,
  type LocalAppleRunnerArtifactReceipt,
  type LocalAppleRunnerConfiguration,
  type LocalAppleRunnerConfigurationLease,
  type LocalAppleRunnerConfigurationReceipt,
  type LocalAppleRunnerWorkspace,
  type LocalAppleRunnerWorkspaceFactory,
} from './runner/runner-local-artifact-contract.ts';
