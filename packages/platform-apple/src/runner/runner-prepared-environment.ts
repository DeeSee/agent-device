import { AppError } from '@agent-device/kernel/errors';
import type { XmlNode } from '@agent-device/xml';
import { stableJsonStringify } from './runner-cache-metadata.ts';
import {
  parsePreparedPlist,
  preparedDictionaryEntries,
  preparedPlistSemanticValue,
  readPreparedDictionaryEntry,
  readPreparedDictionaryString,
  requirePreparedDictionary,
  validatePreparedDictionaryTree,
} from './runner-prepared-plist.ts';
import {
  collectPreparedStructuralIdentity,
  type PreparedRunnerTargetIdentity,
} from './runner-prepared-structure.ts';

const ENVIRONMENT_KEYS = [
  'EnvironmentVariables',
  'UITestEnvironmentVariables',
  'UITargetAppEnvironmentVariables',
  'TestingEnvironmentVariables',
] as const;
const ENVIRONMENT_VERSION_KEY = 'AGENT_DEVICE_RUNNER_ENV_VERSION';
const RUNNER_PORT_KEY = 'AGENT_DEVICE_RUNNER_PORT';
const CAPTURE_POLICY = {
  PreferredScreenCaptureFormat: 'screenshots',
  SystemAttachmentLifetime: 'keepNever',
  UserAttachmentLifetime: 'keepNever',
} as const;

export type PreparedRunnerEnvironment = Readonly<{
  version: 1;
  runnerPort: number;
}>;

export type RunnerXctestrunInspection = Readonly<{
  semanticJson: string;
  declaredTestHostContainerBundleId: string;
  productReferences: readonly string[];
  unownedProductReferences: readonly string[];
  targets: readonly PreparedRunnerTargetIdentity[];
}>;

export type { PreparedRunnerTargetIdentity } from './runner-prepared-structure.ts';

export function inspectRunnerXctestrunXml(sourceXml: string): RunnerXctestrunInspection {
  const { root, targets } = parseRunnerXctestrun(sourceXml);
  return Object.freeze({
    semanticJson: stableJsonStringify(preparedPlistSemanticValue(root)),
    ...collectPreparedStructuralIdentity(root, targets),
  });
}

function parseRunnerXctestrun(sourceXml: string): {
  plist: XmlNode;
  root: XmlNode;
  targets: XmlNode[];
} {
  const plist = parsePreparedPlist(sourceXml);
  const root = requirePreparedDictionary(
    plist.children[0],
    'XCTest runner plist root must be a dictionary',
  );
  validatePreparedDictionaryTree(root);
  const targets = collectTestTargets(root);
  if (targets.length === 0) {
    throw invalidPreparedEnvironment('XCTest runner has no runnable test targets');
  }
  return { plist, root, targets };
}

export function detectPreparedRunnerEnvironment(
  bytes: Buffer,
): PreparedRunnerEnvironment | undefined {
  const source = bytes.toString('utf8');
  let plist: XmlNode;
  try {
    plist = parsePreparedPlist(source);
  } catch (error) {
    if (source.includes(ENVIRONMENT_VERSION_KEY) || source.includes(RUNNER_PORT_KEY)) {
      throw invalidPreparedEnvironment('Marked XCTest runner is not valid XML', error);
    }
    return undefined;
  }

  const root = requirePreparedDictionary(
    plist.children[0],
    'XCTest runner plist root must be a dictionary',
  );
  validatePreparedDictionaryTree(root);
  const targets = collectTestTargets(root);
  const markerPresent = targets.some((target) =>
    ENVIRONMENT_KEYS.some((key) => {
      const environment = readPreparedDictionaryEntry(target, key);
      return (
        environment?.name === 'dict' &&
        (readPreparedDictionaryEntry(environment, ENVIRONMENT_VERSION_KEY) !== undefined ||
          readPreparedDictionaryEntry(environment, RUNNER_PORT_KEY) !== undefined)
      );
    }),
  );
  if (!markerPresent) return undefined;
  if (targets.length === 0) {
    throw invalidPreparedEnvironment('Marked XCTest runner has no runnable test targets');
  }

  const ports = new Set<number>();
  for (const target of targets) {
    for (const environmentKey of ENVIRONMENT_KEYS) {
      const environment = readPreparedDictionaryEntry(target, environmentKey);
      if (environment?.name !== 'dict') {
        throw invalidPreparedEnvironment(`Marked XCTest runner is missing ${environmentKey}`);
      }
      const version = readPreparedDictionaryString(environment, ENVIRONMENT_VERSION_KEY);
      const portValue = readPreparedDictionaryString(environment, RUNNER_PORT_KEY);
      if (version !== '1') {
        throw invalidPreparedEnvironment('XCTest runner environment version is unsupported');
      }
      const port = Number(portValue);
      assertRunnerPort(port);
      ports.add(port);
    }
    if (readPreparedDictionaryString(target, 'TestBundlePath')) {
      for (const [key, value] of Object.entries(CAPTURE_POLICY)) {
        if (readPreparedDictionaryString(target, key) !== value) {
          throw invalidPreparedEnvironment('XCTest runner capture policy is not canonical');
        }
      }
    }
  }
  if (ports.size !== 1) {
    throw invalidPreparedEnvironment('XCTest runner environment contains conflicting ports');
  }
  return Object.freeze({ version: 1, runnerPort: [...ports][0] as number });
}

function collectTestTargets(root: XmlNode): XmlNode[] {
  const configured: XmlNode[] = [];
  const configurations = readPreparedDictionaryEntry(root, 'TestConfigurations');
  if (configurations?.name === 'array') {
    for (const configuration of configurations.children) {
      if (configuration.name !== 'dict') continue;
      const targets = readPreparedDictionaryEntry(configuration, 'TestTargets');
      if (targets?.name === 'array') {
        configured.push(...targets.children.filter((target) => target.name === 'dict'));
      }
    }
  }
  if (configured.length > 0) return configured;
  return preparedDictionaryEntries(root)
    .map((entry) => entry.value)
    .filter(
      (value) =>
        value.name === 'dict' &&
        (readPreparedDictionaryEntry(value, 'TestBundlePath') !== undefined ||
          readPreparedDictionaryEntry(value, 'TestHostPath') !== undefined),
    );
}

function assertRunnerPort(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw invalidPreparedEnvironment('XCTest runner port must be a nonzero UInt16');
  }
}

function invalidPreparedEnvironment(message: string, cause?: unknown): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'runner_prepared_environment_invalid',
    ...(cause === undefined ? {} : { cause: String(cause) }),
  });
}
