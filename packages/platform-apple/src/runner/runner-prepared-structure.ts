import { AppError } from '@agent-device/kernel/errors';
import type { XmlNode } from '@agent-device/xml';
import {
  preparedDictionaryEntries,
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

  const unownedProductReferences = collectProductReferences(root, new Set(targets));
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
  const references = new Set<string>();
  if (node.name === 'dict') {
    for (const { key, value } of preparedDictionaryEntries(node)) {
      if (!PRODUCT_REFERENCE_KEYS.has(key)) {
        for (const reference of collectProductReferences(value, excludedNodes)) {
          references.add(reference);
        }
        continue;
      }
      if (ARRAY_PRODUCT_REFERENCE_KEYS.has(key)) {
        if (value.name !== 'array') {
          throw invalidPreparedStructure(`XCTest runner ${key} must be an array`);
        }
        for (const item of value.children) {
          if (item.name !== 'string' || !item.text) {
            throw invalidPreparedStructure(`XCTest runner ${key} contains an invalid path`);
          }
          references.add(requireRelocatableProductReference(item.text));
        }
      } else {
        if (value.name !== 'string' || !value.text) {
          throw invalidPreparedStructure(`XCTest runner ${key} must be a nonempty string`);
        }
        references.add(requireRelocatableProductReference(value.text));
      }
    }
  } else {
    for (const child of node.children) {
      for (const reference of collectProductReferences(child, excludedNodes)) {
        references.add(reference);
      }
    }
  }
  return Object.freeze([...references].sort());
}

function requireRelocatableProductReference(
  value: string,
  requiredPrefix?: '__TESTHOST__/' | '__TESTROOT__/',
): string {
  const prefix = value.startsWith('__TESTROOT__/')
    ? '__TESTROOT__/'
    : value.startsWith('__TESTHOST__/')
      ? '__TESTHOST__/'
      : undefined;
  const relativePath = prefix ? value.slice(prefix.length) : '';
  const normalized = relativePath ? relativePath.split('/').filter(Boolean).join('/') : '';
  if (
    !prefix ||
    (requiredPrefix !== undefined && prefix !== requiredPrefix) ||
    !relativePath ||
    relativePath.startsWith('/') ||
    normalized !== relativePath ||
    relativePath.split('/').some((component) => component === '.' || component === '..')
  ) {
    throw invalidPreparedStructure('XCTest runner product reference is not relocatable');
  }
  return value;
}

function invalidPreparedStructure(message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'runner_prepared_environment_invalid',
  });
}
