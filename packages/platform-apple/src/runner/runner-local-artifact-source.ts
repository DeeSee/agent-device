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
  validateBuildRequestIdentity(options);
  validateArtifactBuildSettings(options);
  validateArtifactBuildEnvironment(options.environment);
  const sourceRoot = requireSourceRoot(options.sourceRoot);
  const sourceVersion = readAgentDeviceArtifactVersion(sourceRoot);
  if (expectedAgentDeviceVersion !== undefined && sourceVersion !== expectedAgentDeviceVersion) {
    throw new AppleRunnerArtifactBuildError(
      'source_invalid',
      `Runner source version ${sourceVersion} does not match loaded agent-device ${expectedAgentDeviceVersion}`,
    );
  }
  // The output directory is created only after complete request and source admission.
  const outputParent = prepareOutputParent(options.outputParent);
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

function validateBuildRequestIdentity(options: LocalAppleRunnerArtifactOptions): void {
  if (!isRecord(options)) throw invalid('Build options must be an object');
  if (typeof options.sourceRoot !== 'string' || typeof options.outputParent !== 'string')
    throw invalid('Source root and output parent must be strings');
  if (options.variant !== 'device' && options.variant !== 'simulator')
    throw invalid('Variant must be device or simulator');
  if (typeof options.destination !== 'string' || !options.destination)
    throw invalid('A non-empty Xcode destination is required');
}

function validateArtifactBuildSettings(options: LocalAppleRunnerArtifactOptions): void {
  const settings = options.settings;
  if (!isRecord(settings) || !hasExactKeys(settings, SETTING_KEYS))
    throw invalid('Build settings must have the exact typed shape');
  if (
    !settings.appBundleId ||
    !settings.testBundleId ||
    Object.values(settings).some((value) => typeof value !== 'string' && value !== null)
  )
    throw invalid('Both bundle identifiers and typed build-setting values are required');
  if (options.variant === 'device') validateDeviceSigning(settings);
  else validateSimulatorSigning(settings);
}

function validateDeviceSigning(settings: LocalAppleRunnerArtifactOptions['settings']): void {
  const required = [
    settings.architectures,
    settings.developmentTeam,
    settings.codeSignIdentity,
    settings.provisioningProfileSpecifier,
  ];
  if (
    !required.every(isNonEmpty) ||
    settings.codeSignStyle !== 'Manual' ||
    settings.codeSigningAllowed !== 'YES' ||
    settings.codeSigningRequired !== 'YES'
  )
    throw invalid('Device builds require architecture and complete explicit Manual signing inputs');
}

function validateSimulatorSigning(settings: LocalAppleRunnerArtifactOptions['settings']): void {
  const selectors = [
    settings.developmentTeam,
    settings.codeSignIdentity,
    settings.codeSignStyle,
    settings.provisioningProfileSpecifier,
    settings.codeSigningAllowed,
    settings.codeSigningRequired,
  ];
  if (selectors.some((value) => value !== null))
    throw invalid('Simulator signing policy is provider-owned; signing selectors must be null');
}

function validateArtifactBuildEnvironment(
  environment: LocalAppleRunnerArtifactOptions['environment'],
): void {
  if (!isRecord(environment) || !hasOnlyKeys(environment, ENVIRONMENT_KEYS))
    throw invalid('Build environment contains a non-allow-listed key');
  if (Object.values(environment).some((value) => typeof value !== 'string'))
    throw invalid('Build environment values must be strings');
}

function requireSourceRoot(sourceRoot: string): string {
  const resolved = path.resolve(sourceRoot);
  if (
    !fs.existsSync(resolved) ||
    fs.lstatSync(resolved).isSymbolicLink() ||
    !fs.lstatSync(resolved).isDirectory()
  )
    throw new AppleRunnerArtifactBuildError(
      'source_invalid',
      'Agent-device source root is missing or unsafe',
    );
  return resolved;
}

function prepareOutputParent(outputParent: string): string {
  const resolved = path.resolve(outputParent);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw invalid('Output parent must be a real directory');
  return resolved;
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
