import { AppError } from '@agent-device/kernel/errors';
import { parseXmlDocumentSync, type XmlNode } from '@agent-device/xml';

export function parsePreparedPlist(source: string): XmlNode {
  try {
    const roots = parseXmlDocumentSync(source, { maxDocumentChars: 16 * 1024 * 1024 });
    const plistRoots = roots.filter((node) => node.name === 'plist');
    if (plistRoots.length !== 1 || plistRoots[0]?.children.length !== 1) {
      throw invalidPreparedPlist('Expected one XCTest runner plist root value');
    }
    return plistRoots[0];
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidPreparedPlist('Invalid XCTest runner plist XML');
  }
}

export function readPreparedDictionaryEntry(dictionary: XmlNode, key: string): XmlNode | undefined {
  return preparedDictionaryEntries(dictionary).find((entry) => entry.key === key)?.value;
}

export function readPreparedDictionaryString(dictionary: XmlNode, key: string): string | undefined {
  const value = readPreparedDictionaryEntry(dictionary, key);
  return value?.name === 'string' ? (value.text ?? '') : undefined;
}

export function preparedDictionaryEntries(dictionary: XmlNode): {
  key: string;
  value: XmlNode;
}[] {
  requirePreparedDictionary(dictionary, 'Expected plist dictionary');
  if (dictionary.children.length % 2 !== 0) {
    throw invalidPreparedPlist('Malformed XCTest runner plist dictionary');
  }
  const entries = [];
  const keys = new Set<string>();
  for (let index = 0; index < dictionary.children.length; index += 2) {
    const key = dictionary.children[index];
    const value = dictionary.children[index + 1];
    if (key?.name !== 'key' || key.text === null || !value) {
      throw invalidPreparedPlist('Malformed XCTest runner plist dictionary entry');
    }
    if (keys.has(key.text)) {
      throw invalidPreparedPlist(`XCTest runner plist contains duplicate key ${key.text}`);
    }
    keys.add(key.text);
    entries.push({ key: key.text, value });
  }
  return entries;
}

export function validatePreparedDictionaryTree(node: XmlNode): void {
  if (node.name === 'dict') preparedDictionaryEntries(node);
  for (const child of node.children) validatePreparedDictionaryTree(child);
}

export function requirePreparedDictionary(node: XmlNode | undefined, message: string): XmlNode {
  if (node?.name !== 'dict') throw invalidPreparedPlist(message);
  return node;
}

export function preparedPlistSemanticValue(node: XmlNode): unknown {
  if (node.name === 'dict') {
    return Object.fromEntries(
      preparedDictionaryEntries(node)
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(({ key, value }) => [key, preparedPlistSemanticValue(value)]),
    );
  }
  if (node.name === 'array') return node.children.map(preparedPlistSemanticValue);
  return { type: node.name, value: node.text ?? null };
}

function invalidPreparedPlist(message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'runner_prepared_environment_invalid',
  });
}
