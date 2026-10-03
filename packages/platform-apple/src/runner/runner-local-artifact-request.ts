import type {
  AppleRunnerArtifactBuildInput,
  LocalAppleRunnerArtifactOptions,
} from './runner-local-artifact-contract.ts';

export function createLocalRunnerBuildInput(
  input: Required<LocalAppleRunnerArtifactOptions>,
  frozenSource: string,
  derivedData: string,
): AppleRunnerArtifactBuildInput {
  return Object.freeze({
    sourceRoot: frozenSource,
    derivedData,
    destination: input.destination,
    variant: input.variant,
    environment: Object.freeze({ ...input.environment }),
    settings: Object.freeze({ ...input.settings }),
  });
}

export function serializeLocalRunnerBuildRequestIdentity(
  input: AppleRunnerArtifactBuildInput,
): Buffer {
  const environment = input.environment;
  const settings = input.settings;
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      workflow: 'agent-device-xcodebuild-build-for-testing-v1',
      variant: input.variant,
      destination: input.destination,
      environment: {
        PATH: environment.PATH ?? null,
        HOME: environment.HOME ?? null,
        TMPDIR: environment.TMPDIR ?? null,
        USER: environment.USER ?? null,
        LOGNAME: environment.LOGNAME ?? null,
        LANG: environment.LANG ?? null,
        LC_ALL: environment.LC_ALL ?? null,
        DEVELOPER_DIR: environment.DEVELOPER_DIR ?? null,
      },
      settings: {
        appBundleId: settings.appBundleId,
        testBundleId: settings.testBundleId,
        architectures: settings.architectures,
        developmentTeam: settings.developmentTeam,
        codeSignIdentity: settings.codeSignIdentity,
        codeSignStyle: settings.codeSignStyle,
        provisioningProfileSpecifier: settings.provisioningProfileSpecifier,
        codeSigningAllowed: settings.codeSigningAllowed,
        codeSigningRequired: settings.codeSigningRequired,
      },
      variantPolicy:
        input.variant === 'simulator'
          ? 'xcode-simulator-ad-hoc-signing-v2'
          : 'caller-supplied-device-signing-v1',
      // Ephemeral private source/DerivedData paths are excluded. Their source
      // and product bytes are independently fingerprinted by the candidate.
    }),
  );
}
