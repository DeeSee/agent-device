import { AppError } from '@agent-device/kernel/errors';
import type { XmlNode } from '@agent-device/xml';
import {
  preparedDictionaryEntries,
  readPreparedDictionaryEntry,
  readPreparedDictionaryString,
} from './runner-prepared-plist.ts';

const PRODUCT_REFERENCE_KEYS = new Set([
  'ProductPaths',
  'DependentProductPaths',
  'TestHostPath',
  'TestBundlePath',
  'UITargetAppPath',
]);
const ARRAY_PRODUCT_REFERENCE_KEYS = new Set(['ProductPaths', 'DependentProductPaths']);

export type PreparedRunnerTargetIdentity = Readonly<{
  declaredTestHostContainerBundleId: string;
  testHostPath: string;
  testBundlePath: string;
  productReferences: readonly string[];
}>;

export function collectPreparedStructuralIdentity(
  root: XmlNode,
  targets: readonly XmlNode[],
): {
  declaredTestHostContainerBundleId: string;
  productReferences: readonly string[];
  unownedProductReferences: readonly string[];
  targets: readonly PreparedRunnerTargetIdentity[];
} {
  const bundleIds = new Set<string>();
  const targetIdentities = targets.map((target) => {
    const bundleId = readPreparedDictionaryString(target, 'TestHostBundleIdentifier');
    const hostPath = readPreparedDictionaryString(target, 'TestHostPath');
    const testBundlePath = readPreparedDictionaryString(target, 'TestBundlePath');
    if (!bundleId || !hostPath || !testBundlePath) {
      throw invalidPreparedStructure('XCTest runner test-host identity is incomplete');
    }
    bundleIds.add(bundleId);
    return Object.freeze({
      declaredTestHostContainerBundleId: bundleId,
      testHostPath: requireRelocatableProductReference(hostPath, '__TESTROOT__/'),
      testBundlePath: requireRelocatableProductReference(testBundlePath, '__TESTHOST__/'),
      productReferences: collectProductReferences(target),
    });
  });
  if (bundleIds.size !== 1) {
    throw invalidPreparedStructure('XCTest runner test-host identity is ambiguous');
  }

  const excludedNodes = new Set(targets);
  // Coverage build variants are report metadata, not products installed to run a test target.
  const coverageBuildables = readPreparedDictionaryEntry(root, 'CodeCoverageBuildableInfos');
  if (coverageBuildables) excludedNodes.add(coverageBuildables);
  const unownedProductReferences = collectProductReferences(root, excludedNodes);
  if (unownedProductReferences.some((reference) => reference.startsWith('__TESTHOST__/'))) {
    throw invalidPreparedStructure('XCTest runner has an unowned test-host product reference');
  }
  const references = new Set([
    ...unownedProductReferences,
    ...targetIdentities.flatMap((target) => target.productReferences),
  ]);
  if (references.size === 0) {
    throw invalidPreparedStructure('XCTest runner has no referenced products');
  }
  return {
    declaredTestHostContainerBundleId: [...bundleIds][0] as string,
    productReferences: Object.freeze([...references].sort()),
    unownedProductReferences,
    targets: Object.freeze(targetIdentities),
  };
}

function collectProductReferences(
  node: XmlNode,
  excludedNodes: ReadonlySet<XmlNode> = new Set(),
): readonly string[] {
  if (excludedNodes.has(node)) return Object.freeze([]);
  const references =
    node.name === 'dict'
      ? preparedDictionaryEntries(node).flatMap(({ key, value }) =>
          collectNamedProductReferences(key, value, excludedNodes),
        )
      : node.children.flatMap((child) => collectProductReferences(child, excludedNodes));
  return Object.freeze([...new Set(references)].sort());
}

function collectNamedProductReferences(
  key: string,
  value: XmlNode,
  excludedNodes: ReadonlySet<XmlNode>,
): readonly string[] {
  if (!PRODUCT_REFERENCE_KEYS.has(key)) return collectProductReferences(value, excludedNodes);
  if (!ARRAY_PRODUCT_REFERENCE_KEYS.has(key))
    return [readProductReferenceNode(value, `XCTest runner ${key} must be a nonempty string`)];
  if (value.name !== 'array')
    throw invalidPreparedStructure(`XCTest runner ${key} must be an array`);
  return value.children.map((item) =>
    readProductReferenceNode(item, `XCTest runner ${key} contains an invalid path`),
  );
}

function readProductReferenceNode(node: XmlNode, message: string): string {
  if (node.name !== 'string' || !node.text) throw invalidPreparedStructure(message);
  return requireRelocatableProductReference(node.text);
}

function requireRelocatableProductReference(
  value: string,
  requiredPrefix?: '__TESTHOST__/' | '__TESTROOT__/',
): string {
  const prefixes = ['__TESTROOT__/', '__TESTHOST__/'] as const;
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  if (!prefix || (requiredPrefix !== undefined && prefix !== requiredPrefix))
    throw invalidPreparedStructure('XCTest runner product reference is not relocatable');
  const components = value.slice(prefix.length).split('/');
  if (!components.every((component) => component !== '' && component !== '.' && component !== '..'))
    throw invalidPreparedStructure('XCTest runner product reference is not relocatable');
  return value;
}

function invalidPreparedStructure(message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'runner_prepared_environment_invalid',
  });
}
