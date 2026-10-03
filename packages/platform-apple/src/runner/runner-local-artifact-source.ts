import { readAgentDeviceArtifactVersion } from './runner-package-root.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  AppleRunnerArtifactBuildError,
  type LocalAppleRunnerArtifactOptions,
} from './runner-local-artifact-contract.ts';

const SETTING_KEYS = [
  'appBundleId',
  'testBundleId',
  'architectures',
  'developmentTeam',
  'codeSignIdentity',
  'codeSignStyle',
  'provisioningProfileSpecifier',
  'codeSigningAllowed',
  'codeSigningRequired',
] as const;

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

export type ValidatedLocalRunnerArtifactOptions = Required<LocalAppleRunnerArtifactOptions> &
  Readonly<{ agentDeviceVersion: string }>;

export function validateLocalRunnerArtifactOptions(
  options: LocalAppleRunnerArtifactOptions,
  expectedAgentDeviceVersion?: string,
): ValidatedLocalRunnerArtifactOptions {
  if (!isRecord(options)) throw invalid('Build options must be an object');
  const { sourceRoot: rawSourceRoot, outputParent: rawOutputParent } = options;
  if (typeof rawSourceRoot !== 'string' || typeof rawOutputParent !== 'string') {
    throw invalid('Source root and output parent must be strings');
  }
  if (options.variant !== 'device' && options.variant !== 'simulator') {
    throw invalid('Variant must be device or simulator');
  }
  if (typeof options.destination !== 'string' || !options.destination) {
    throw invalid('A non-empty Xcode destination is required');
  }
  if (!isRecord(options.settings) || !hasExactKeys(options.settings, SETTING_KEYS)) {
    throw invalid('Build settings must have the exact typed shape');
  }
  if (
    !options.settings.appBundleId ||
    !options.settings.testBundleId ||
    Object.values(options.settings).some((value) => typeof value !== 'string' && value !== null)
  ) {
    throw invalid('Both bundle identifiers and typed build-setting values are required');
  }
  if (
    options.variant === 'simulator' &&
    [
      options.settings.developmentTeam,
      options.settings.codeSignIdentity,
      options.settings.codeSignStyle,
      options.settings.provisioningProfileSpecifier,
      options.settings.codeSigningAllowed,
      options.settings.codeSigningRequired,
    ].some((value) => value !== null)
  ) {
    throw invalid('Simulator signing policy is provider-owned; signing selectors must be null');
  }
  if (options.variant === 'device') {
    const settings = options.settings;
    if (
      !isNonEmpty(settings.architectures) ||
      !isNonEmpty(settings.developmentTeam) ||
      !isNonEmpty(settings.codeSignIdentity) ||
      settings.codeSignStyle !== 'Manual' ||
      !isNonEmpty(settings.provisioningProfileSpecifier) ||
      settings.codeSigningAllowed !== 'YES' ||
      settings.codeSigningRequired !== 'YES'
    ) {
      throw invalid(
        'Device builds require architecture and complete explicit Manual signing inputs',
      );
    }
  }
  if (!isRecord(options.environment) || !hasOnlyKeys(options.environment, ENVIRONMENT_KEYS)) {
    throw invalid('Build environment contains a non-allow-listed key');
  }
  if (Object.values(options.environment).some((value) => typeof value !== 'string')) {
    throw invalid('Build environment values must be strings');
  }

  const sourceRoot = path.resolve(rawSourceRoot);
  const outputParent = path.resolve(rawOutputParent);
  if (
    !fs.existsSync(sourceRoot) ||
    fs.lstatSync(sourceRoot).isSymbolicLink() ||
    !fs.lstatSync(sourceRoot).isDirectory()
  ) {
    throw new AppleRunnerArtifactBuildError(
      'source_invalid',
      'Agent-device source root is missing or unsafe',
    );
  }
  const sourceVersion = readAgentDeviceArtifactVersion(sourceRoot);
  if (expectedAgentDeviceVersion !== undefined && sourceVersion !== expectedAgentDeviceVersion) {
    throw new AppleRunnerArtifactBuildError(
      'source_invalid',
      `Runner source version ${sourceVersion} does not match loaded agent-device ${expectedAgentDeviceVersion}`,
    );
  }

  // Creating the output parent is the first mutation and happens only after
  // complete request and provider/source-version admission.
  fs.mkdirSync(outputParent, { recursive: true, mode: 0o700 });
  const outputStat = fs.lstatSync(outputParent);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw invalid('Output parent must be a real directory');
  }
  return {
    sourceRoot,
    outputParent,
    variant: options.variant,
    destination: options.destination,
    environment: Object.freeze({ ...options.environment }),
    settings: Object.freeze({ ...options.settings }),
    agentDeviceVersion: sourceVersion,
  };
}

export function assertAgentDeviceArtifactVersion(sourceRoot: string, expected: string): void {
  const actual = readAgentDeviceArtifactVersion(sourceRoot);
  if (actual !== expected) {
    throw new AppleRunnerArtifactBuildError(
      'source_invalid',
      `Runner source package version changed from ${expected} to ${actual}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmpty(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalid(message: string): AppleRunnerArtifactBuildError {
  return new AppleRunnerArtifactBuildError('invalid_options', message);
}
