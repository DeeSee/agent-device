import path from 'node:path';
import { runCmdBackground, runCmdSync } from './host.ts';
import {
  AppleRunnerArtifactBuildError,
  type AppleRunnerArtifactBuildEffects,
  type AppleRunnerArtifactBuildInput,
  type AppleRunnerArtifactToolchain,
} from './runner-local-artifact-contract.ts';
import { createRunnerBuildForTestingArguments } from './runner-build-arguments.ts';
import {
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
} from './runner-cache-metadata.ts';
import { resolveExistingXctestrunProductPaths } from './runner-xctestrun-products.ts';

export const localAppleRunnerArtifactEffects: AppleRunnerArtifactBuildEffects = Object.freeze({
  build: runRunnerBuild,
  inspectToolchain: readToolchain,
  validateXctestrun: resolveExistingXctestrunProductPaths,
});

async function runRunnerBuild(input: AppleRunnerArtifactBuildInput): Promise<void> {
  const args = createRunnerBuildArguments(input);
  try {
    await runCmdBackground('xcodebuild', args, {
      cwd: input.sourceRoot,
      env: { ...input.environment },
      stdio: 'inherit',
      captureOutput: false,
    }).wait;
  } catch (error) {
    throw new AppleRunnerArtifactBuildError(
      'build_failed',
      'Runner build-for-testing failed',
      error,
    );
  }
}

/** @internal Exact provider-owned argv projection for tests and review. */
export function createRunnerBuildArguments(input: AppleRunnerArtifactBuildInput): string[] {
  const project = path.join(
    input.sourceRoot,
    'apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj',
  );
  return createRunnerBuildForTestingArguments({
    projectPath: project,
    destinationArgs: ['-destination', input.destination],
    derivedDataPath: input.derivedData,
    maximumConcurrentDestinationsFlag:
      input.variant === 'device'
        ? '-maximum-concurrent-test-device-destinations'
        : '-maximum-concurrent-test-simulator-destinations',
    buildSettings: [
      ...resolveRunnerPerformanceBuildSettings(),
      ...resolveRunnerSandboxBuildArgs(input.environment),
      `AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=${input.settings.appBundleId}`,
      `AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=${input.settings.testBundleId}`,
      ...optionalBuildSettings(input),
    ],
  });
}

async function readToolchain(
  input: AppleRunnerArtifactBuildInput,
): Promise<AppleRunnerArtifactToolchain> {
  const xcode = capture('xcodebuild', ['-version'], input.environment);
  const xcodeVersion = /^Xcode (.+)$/mu.exec(xcode)?.[1];
  const xcodeBuild = /^Build version (.+)$/mu.exec(xcode)?.[1];
  const sdk = input.variant === 'device' ? 'iphoneos' : 'iphonesimulator';
  const sdkVersion = capture(
    'xcrun',
    ['--sdk', sdk, '--show-sdk-version'],
    input.environment,
  ).trim();
  const sdkBuild = capture(
    'xcrun',
    ['--sdk', sdk, '--show-sdk-build-version'],
    input.environment,
  ).trim();
  if (!xcodeVersion || !xcodeBuild || !sdkVersion || !sdkBuild) {
    throw new AppleRunnerArtifactBuildError(
      'toolchain_invalid',
      'Unable to identify the Xcode and SDK used for the runner artifact',
    );
  }
  return Object.freeze({ xcodeVersion, xcodeBuild, sdk, sdkVersion, sdkBuild });
}

function capture(
  command: string,
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  try {
    return runCmdSync(command, [...args], { env: { ...environment } }).stdout;
  } catch (error) {
    throw new AppleRunnerArtifactBuildError(
      'toolchain_invalid',
      `Unable to run ${command} for runner artifact identity`,
      error,
    );
  }
}

function optionalBuildSettings(input: AppleRunnerArtifactBuildInput): string[] {
  const settings = input.settings;
  const architecture = [['ARCHS', settings.architectures] as const];
  if (input.variant === 'simulator') {
    return architecture.flatMap(([name, value]) => (value === null ? [] : [`${name}=${value}`]));
  }
  return [
    ...architecture,
    ['DEVELOPMENT_TEAM', settings.developmentTeam],
    ['CODE_SIGN_IDENTITY', settings.codeSignIdentity],
    ['CODE_SIGN_STYLE', settings.codeSignStyle],
    ['PROVISIONING_PROFILE_SPECIFIER', settings.provisioningProfileSpecifier],
    ['CODE_SIGNING_ALLOWED', settings.codeSigningAllowed],
    ['CODE_SIGNING_REQUIRED', settings.codeSigningRequired],
  ].flatMap(([name, value]) => (value === null ? [] : [`${name}=${value}`]));
}
