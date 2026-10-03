import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppleRunnerArtifactBuildError,
  buildLocalAppleRunnerArtifact,
  type AppleRunnerArtifactBuildEnvironment,
  type AppleRunnerArtifactBuildSettings,
  type AppleRunnerArtifactVariant,
} from '../sdk/artifacts.ts';

const USAGE = `Build the runner shipped by this agent-device checkout as a local artifact.

Usage:
  pnpm build:xcuitest:ios:artifact -- --variant device|simulator \\
    --output-parent PATH [--destination XCODE_DESTINATION]

The existing build inputs remain authoritative:
  AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID
  AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID
  AGENT_DEVICE_XCUITEST_ARCHS

For a manually signed physical build, select the pinned Xcode with DEVELOPER_DIR
and export DEVELOPMENT_TEAM, CODE_SIGN_IDENTITY, CODE_SIGN_STYLE=Manual,
PROVISIONING_PROFILE_SPECIFIER, CODE_SIGNING_ALLOWED=YES, and
CODE_SIGNING_REQUIRED=YES. A wildcard profile is valid only when the distributor
independently verifies its application-identifier, team, certificate,
registered-device, entitlement, and expiry grants for every signable product.

This source-checkout command first builds dist/src, then executes and fingerprints
that exact compiled producer closure. It builds a private frozen copy of the
runner project with one closed request.

The result is an untrusted local_unpublished candidate with
activationEligible:false. Upload, descriptor-safe attestation, artifact signing,
promotion, rotation, and revocation remain the distributor's responsibility.`;

type Arguments = Readonly<{
  variant: AppleRunnerArtifactVariant;
  outputParent: string;
  destination: string;
}>;

const ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'DEVELOPER_DIR',
] as const;

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const receipt = await buildLocalAppleRunnerArtifact({
    sourceRoot,
    ...parsed,
    environment: readBuildEnvironment(),
    settings: readBuildSettings(parsed.variant),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

function parseArguments(args: readonly string[]): Arguments | 'help' {
  if (args[0] === '--') return parseArguments(args.slice(1));
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (isHelpArgument(name)) return 'help';
    addBuildArgument(values, name, args[index + 1]);
  }
  return requireBuildArguments(values);
}

function addBuildArgument(
  values: Map<string, string>,
  name: string | undefined,
  value: string | undefined,
): void {
  const key = requireBuildArgumentName(name);
  if (values.has(key))
    throw new AppleRunnerArtifactBuildError('invalid_options', `Duplicate argument: ${key}`);
  values.set(key, requireBuildArgumentValue(key, value));
}

function requireBuildArgumentName(name: string | undefined): string {
  if (name === undefined || !['--variant', '--output-parent', '--destination'].includes(name))
    throw new AppleRunnerArtifactBuildError(
      'invalid_options',
      `Unsupported argument: ${String(name)}`,
    );
  return name;
}

function requireBuildArgumentValue(name: string, value: string | undefined): string {
  if (!value || value.startsWith('--'))
    throw new AppleRunnerArtifactBuildError('invalid_options', `${name} requires one value`);
  return value;
}

function requireBuildArguments(values: ReadonlyMap<string, string>): Arguments {
  const variant = requireBuildVariant(values.get('--variant'));
  const outputParent = values.get('--output-parent');
  if (!outputParent)
    throw new AppleRunnerArtifactBuildError(
      'invalid_options',
      '--variant device|simulator and --output-parent are required',
    );
  return {
    variant,
    outputParent: path.resolve(outputParent),
    destination:
      values.get('--destination') ??
      (variant === 'device' ? 'generic/platform=iOS' : 'generic/platform=iOS Simulator'),
  };
}

function readBuildEnvironment(): AppleRunnerArtifactBuildEnvironment {
  return Object.freeze(
    Object.fromEntries(
      ENVIRONMENT_KEYS.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    ),
  );
}

function readBuildSettings(variant: AppleRunnerArtifactVariant): AppleRunnerArtifactBuildSettings {
  const appBundleId =
    process.env.AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID ?? 'com.callstack.agentdevice.runner';
  const signing = (key: string) => (variant === 'simulator' ? null : (process.env[key] ?? null));
  return Object.freeze({
    appBundleId,
    testBundleId: process.env.AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID ?? `${appBundleId}.uitests`,
    architectures: process.env.AGENT_DEVICE_XCUITEST_ARCHS ?? null,
    developmentTeam: signing('DEVELOPMENT_TEAM'),
    codeSignIdentity: signing('CODE_SIGN_IDENTITY'),
    codeSignStyle: signing('CODE_SIGN_STYLE'),
    provisioningProfileSpecifier: signing('PROVISIONING_PROFILE_SPECIFIER'),
    codeSigningAllowed: signing('CODE_SIGNING_ALLOWED'),
    codeSigningRequired: signing('CODE_SIGNING_REQUIRED'),
  });
}

main().catch((error: unknown) => {
  const typed =
    error instanceof AppleRunnerArtifactBuildError
      ? { code: error.code, message: error.message }
      : { code: 'publication_failed', message: String(error) };
  process.stderr.write(`${JSON.stringify(typed)}\n${USAGE}\n`);
  process.exitCode = 1;
});

function isHelpArgument(name: string | undefined): boolean {
  return name === '--help' || name === '-h';
}

function requireBuildVariant(value: string | undefined): AppleRunnerArtifactVariant {
  if (value !== 'device' && value !== 'simulator')
    throw new AppleRunnerArtifactBuildError(
      'invalid_options',
      '--variant device|simulator and --output-parent are required',
    );
  return value;
}
