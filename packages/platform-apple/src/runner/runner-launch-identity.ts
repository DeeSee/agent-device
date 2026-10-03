import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { readApplePlistJson } from './host.ts';
import {
  comparableRunnerCacheMetadata,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
  resolveRunnerTestHostBundleId,
  stableJsonStringify,
  type RunnerXctestrunCacheMetadata,
  type RunnerPhaseBudget,
} from './runner-cache-metadata.ts';

export type RunnerLaunchIdentity = Readonly<{
  selectorFingerprint: string;
  testHostContainerBundleId: string;
}>;

export type RunnerLaunchSelection = Readonly<{
  source: 'internal' | 'external';
  identity: RunnerLaunchIdentity;
  derived: string;
  envDir?: string;
  xctestrunPath?: string;
  xctestrunSha256?: string;
  expectedCacheMetadata?: RunnerXctestrunCacheMetadata;
}>;

export type RunnerLaunchSelectionOptions = Readonly<{
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
}>;

export async function resolveRunnerLaunchSelection(
  device: DeviceInfo,
  options: RunnerLaunchSelectionOptions,
  budget?: RunnerPhaseBudget,
): Promise<RunnerLaunchSelection> {
  const configuredXctestrunPath = options.iosXctestrunFile?.trim();
  if (configuredXctestrunPath) {
    return await resolveExternalRunnerLaunchSelection(configuredXctestrunPath, options);
  }
  return resolveInternalRunnerLaunchSelection(device, options, budget);
}

async function resolveExternalRunnerLaunchSelection(
  configuredXctestrunPath: string,
  options: RunnerLaunchSelectionOptions,
): Promise<RunnerLaunchSelection> {
  const xctestrunPath = path.resolve(configuredXctestrunPath);
  const opened = readRegularFileNoFollow(xctestrunPath, 'iosXctestrunFile');
  const xctestrunSha256 = opened.sha256;
  const derived = options.iosXctestDerivedDataPath?.trim()
    ? path.resolve(options.iosXctestDerivedDataPath)
    : resolveExternalXctestDerivedDataPath(xctestrunPath);
  const envDir = options.iosXctestEnvDir?.trim()
    ? path.resolve(options.iosXctestEnvDir)
    : path.dirname(xctestrunPath);
  const testHostContainerBundleId = await resolveCoherentTestHostBundleId(xctestrunPath);
  return Object.freeze({
    source: 'external',
    identity: Object.freeze({
      selectorFingerprint: selectorFingerprint({
        schemaVersion: 1,
        source: 'external',
        xctestrunPath,
        xctestrunSha256,
        derived,
        envDir,
      }),
      testHostContainerBundleId,
    }),
    derived,
    envDir,
    xctestrunPath,
    xctestrunSha256,
  });
}

function resolveInternalRunnerLaunchSelection(
  device: DeviceInfo,
  options: RunnerLaunchSelectionOptions,
  budget?: RunnerPhaseBudget,
): RunnerLaunchSelection {
  const expectedCacheMetadata = resolveExpectedRunnerCacheMetadata(device, undefined, budget);
  const derived = resolveRunnerDerivedPath(device, expectedCacheMetadata);
  const configuredEnvDir = options.iosXctestEnvDir?.trim();
  const envDir = configuredEnvDir ? path.resolve(configuredEnvDir) : undefined;
  return Object.freeze({
    source: 'internal',
    identity: Object.freeze({
      selectorFingerprint: selectorFingerprint({
        schemaVersion: 1,
        source: 'internal',
        cache: comparableRunnerCacheMetadata(expectedCacheMetadata),
        envDir: envDir ?? null,
      }),
      testHostContainerBundleId: resolveRunnerTestHostBundleId(),
    }),
    derived,
    ...(envDir === undefined ? {} : { envDir }),
    expectedCacheMetadata,
  });
}

export async function verifyRunnerLaunchSelection(
  selection: RunnerLaunchSelection,
  xctestrunPath: string,
): Promise<void> {
  if (selection.source === 'external') {
    const opened = readRegularFileNoFollow(xctestrunPath, 'iosXctestrunFile');
    if (opened.sha256 !== selection.xctestrunSha256) {
      throw runnerIdentityError(
        'runner_selector_changed',
        'Configured iOS XCTest runner changed while it was being prepared',
      );
    }
  }
  const actualBundleId = await resolveCoherentTestHostBundleId(xctestrunPath);
  if (actualBundleId !== selection.identity.testHostContainerBundleId) {
    throw runnerIdentityError(
      'runner_identity_incoherent',
      'XCTest runner host identity does not match the selected runner configuration',
    );
  }
}

async function resolveCoherentTestHostBundleId(
  xctestrunPath: string,
  parsedXctestrun?: Record<string, unknown>,
): Promise<string> {
  const parsed = parsedXctestrun ?? (await readApplePlistJson(xctestrunPath));
  if (!parsed) {
    throw runnerIdentityError('runner_identity_unbound', 'Failed to read XCTest runner identity');
  }
  const targets = collectTestTargets(parsed);
  if (targets.length === 0) {
    throw runnerIdentityError(
      'runner_identity_unbound',
      'XCTest runner has no configured test-host identity',
    );
  }

  const bundleIds = new Set<string>();
  for (const target of targets) {
    const bundleId = nonemptyString(target.TestHostBundleIdentifier);
    const hostPath = nonemptyString(target.TestHostPath);
    if (!bundleId || !hostPath) {
      throw runnerIdentityError(
        'runner_identity_unbound',
        'XCTest runner test-host identity is incomplete',
      );
    }
    const resolvedHostPath = resolveTestRootPath(xctestrunPath, hostPath);
    const hostInfo = await readApplePlistJson(path.join(resolvedHostPath, 'Info.plist'));
    if (nonemptyString(hostInfo?.CFBundleIdentifier) !== bundleId) {
      throw runnerIdentityError(
        'runner_identity_incoherent',
        'XCTest runner test-host bundle identifier does not match its referenced product',
      );
    }
    bundleIds.add(bundleId);
  }
  if (bundleIds.size !== 1) {
    throw runnerIdentityError(
      'runner_identity_unbound',
      'XCTest runner has ambiguous test-host container identities',
    );
  }
  return Array.from(bundleIds)[0] as string;
}

function collectTestTargets(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const targets: Record<string, unknown>[] = [];
  const configurations = parsed.TestConfigurations;
  if (Array.isArray(configurations)) {
    for (const configuration of configurations) {
      if (!isRecord(configuration) || !Array.isArray(configuration.TestTargets)) continue;
      targets.push(...configuration.TestTargets.filter(isRecord));
    }
  }
  if (targets.length > 0) return targets;
  return Object.values(parsed).filter(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) &&
      ('TestHostBundleIdentifier' in candidate || 'TestHostPath' in candidate),
  );
}

function resolveTestRootPath(xctestrunPath: string, value: string): string {
  const prefix = '__TESTROOT__/';
  if (!value.startsWith(prefix)) {
    throw runnerIdentityError(
      'runner_identity_unbound',
      'XCTest runner test-host path is not relocatable under __TESTROOT__',
    );
  }
  const testRoot = path.dirname(xctestrunPath);
  const resolved = path.resolve(testRoot, value.slice(prefix.length));
  if (resolved === testRoot || !resolved.startsWith(`${testRoot}${path.sep}`)) {
    throw runnerIdentityError(
      'runner_identity_incoherent',
      'XCTest runner test-host path escapes its product root',
    );
  }
  return resolved;
}

function resolveExternalXctestDerivedDataPath(xctestrunPath: string): string {
  const suffix = crypto.createHash('sha256').update(xctestrunPath).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'agent-device-ios-xctest-derived', suffix);
}

function readRegularFileNoFollow(
  filePath: string,
  configKey: string,
): { bytes: Buffer; sha256: string } {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('not a regular file');
    const bytes = fs.readFileSync(descriptor);
    return {
      bytes,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    throw new AppError('COMMAND_FAILED', 'Configured iOS XCTest runner file not found', {
      configKey,
      reason: 'runner_identity_unbound',
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function selectorFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

function runnerIdentityError(reason: string, message: string): AppError {
  return new AppError('COMMAND_FAILED', message, { reason });
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
