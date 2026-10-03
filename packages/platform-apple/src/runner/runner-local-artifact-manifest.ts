import crypto from 'node:crypto';
import {
  AppleRunnerArtifactBuildError,
  type LocalAppleRunnerArtifactManifest,
  type LocalAppleRunnerArtifactManifestEntry,
} from './runner-local-artifact-contract.ts';

const SHA256_PATTERN = '^[0-9a-f]{64}$';
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_REFERENCES = 4_096;
const MAX_PATH_BYTES = 4_096;
const MAX_IDENTITY_BYTES = 1_024;

const digestSchema = Object.freeze({ type: 'string', pattern: SHA256_PATTERN });
const pathSchema = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: MAX_PATH_BYTES,
});

/** Strict public handoff schema; semantic trust remains with the distributor. */
export const LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'agent-device-apple-runner-artifact-v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'schemaVersion',
    'schemaSha256',
    'publicationState',
    'activationEligible',
    'agentDeviceVersion',
    'variant',
    'producer',
    'source',
    'build',
    'toolchain',
    'products',
  ],
  properties: {
    format: { const: 'agent-device-apple-runner-artifact-v1' },
    schemaVersion: { const: 1 },
    schemaSha256: digestSchema,
    publicationState: { const: 'local_unpublished' },
    activationEligible: { const: false },
    agentDeviceVersion: { type: 'string', minLength: 1, maxLength: 128 },
    variant: { enum: ['device', 'simulator'] },
    producer: strictObject(['closure', 'closureSha256'], {
      closure: { const: 'loaded producer module graph' },
      closureSha256: digestSchema,
    }),
    source: strictObject(['checkoutRunnerTreeSha256', 'frozenRunnerTreeSha256'], {
      checkoutRunnerTreeSha256: digestSchema,
      frozenRunnerTreeSha256: digestSchema,
    }),
    build: strictObject(['action', 'destinationClass', 'publicSettings', 'closedRequestSha256'], {
      action: { const: 'build-for-testing' },
      destinationClass: { enum: ['device', 'simulator'] },
      publicSettings: strictObject(['appBundleId', 'testBundleId', 'architectures'], {
        appBundleId: { type: 'string', minLength: 1, maxLength: MAX_IDENTITY_BYTES },
        testBundleId: { type: 'string', minLength: 1, maxLength: MAX_IDENTITY_BYTES },
        architectures: {
          type: ['string', 'null'],
          minLength: 1,
          maxLength: MAX_IDENTITY_BYTES,
        },
      }),
      closedRequestSha256: digestSchema,
    }),
    toolchain: strictObject(['xcodeVersion', 'xcodeBuild', 'sdk', 'sdkVersion', 'sdkBuild'], {
      xcodeVersion: identitySchema(),
      xcodeBuild: identitySchema(),
      sdk: { enum: ['iphoneos', 'iphonesimulator'] },
      sdkVersion: identitySchema(),
      sdkBuild: identitySchema(),
    }),
    products: strictObject(
      [
        'rootRelativePath',
        'baseXctestrunRelativePath',
        'artifactXctestrunRelativePath',
        'baseXctestrunSha256',
        'knownReferencesResolvedAfterCopy',
        'referencedProducts',
        'contentSha256',
        'fileCount',
        'byteCount',
        'entries',
      ],
      {
        rootRelativePath: { const: 'Build/Products' },
        baseXctestrunRelativePath: pathSchema,
        artifactXctestrunRelativePath: pathSchema,
        baseXctestrunSha256: digestSchema,
        knownReferencesResolvedAfterCopy: { const: true },
        referencedProducts: {
          type: 'array',
          maxItems: MAX_REFERENCES,
          items: pathSchema,
        },
        contentSha256: digestSchema,
        fileCount: { type: 'integer', minimum: 1, maximum: MAX_ENTRIES },
        byteCount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        entries: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ENTRIES,
          items: {
            oneOf: [
              strictObject(['kind', 'path', 'mode'], {
                kind: { const: 'directory' },
                path: pathSchema,
                mode: { type: 'integer', minimum: 0, maximum: 0o777 },
              }),
              strictObject(['kind', 'path', 'mode', 'size', 'sha256'], {
                kind: { const: 'file' },
                path: pathSchema,
                mode: { type: 'integer', minimum: 0, maximum: 0o777 },
                size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                sha256: digestSchema,
              }),
            ],
          },
        },
      },
    ),
  },
  allOf: [
    {
      if: { properties: { variant: { const: 'device' } }, required: ['variant'] },
      then: {
        properties: {
          build: {
            properties: {
              publicSettings: {
                properties: { architectures: identitySchema() },
              },
            },
          },
        },
      },
    },
  ],
} as const);

export const LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA_SHA256 = crypto
  .createHash('sha256')
  .update(JSON.stringify(LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA))
  .digest('hex');

export function parseLocalAppleRunnerArtifactManifest(
  input: string | Uint8Array,
): LocalAppleRunnerArtifactManifest {
  const bytes = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) throw invalidManifest();
  try {
    return decodeLocalAppleRunnerArtifactManifest(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof AppleRunnerArtifactBuildError) throw error;
    throw invalidManifest(error);
  }
}

export function decodeLocalAppleRunnerArtifactManifest(
  value: unknown,
): LocalAppleRunnerArtifactManifest {
  const root = exactRecord(value, [
    'format',
    'schemaVersion',
    'schemaSha256',
    'publicationState',
    'activationEligible',
    'agentDeviceVersion',
    'variant',
    'producer',
    'source',
    'build',
    'toolchain',
    'products',
  ]);
  literal(root.format, 'agent-device-apple-runner-artifact-v1');
  literal(root.schemaVersion, 1);
  literal(root.schemaSha256, LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA_SHA256);
  literal(root.publicationState, 'local_unpublished');
  literal(root.activationEligible, false);
  const agentDeviceVersion = boundedString(root.agentDeviceVersion, 128);
  const variant = oneOf(root.variant, ['device', 'simulator'] as const);
  const producer = exactRecord(root.producer, ['closure', 'closureSha256']);
  literal(producer.closure, 'loaded producer module graph');
  const source = exactRecord(root.source, ['checkoutRunnerTreeSha256', 'frozenRunnerTreeSha256']);
  const build = exactRecord(root.build, [
    'action',
    'destinationClass',
    'publicSettings',
    'closedRequestSha256',
  ]);
  literal(build.action, 'build-for-testing');
  literal(build.destinationClass, variant);
  const publicSettings = exactRecord(build.publicSettings, [
    'appBundleId',
    'testBundleId',
    'architectures',
  ]);
  if (variant === 'device' && publicSettings.architectures === null) {
    throw invalidManifest();
  }
  const toolchain = exactRecord(root.toolchain, [
    'xcodeVersion',
    'xcodeBuild',
    'sdk',
    'sdkVersion',
    'sdkBuild',
  ]);
  const sdk = oneOf(toolchain.sdk, ['iphoneos', 'iphonesimulator'] as const);
  literal(sdk, variant === 'device' ? 'iphoneos' : 'iphonesimulator');
  const products = exactRecord(root.products, [
    'rootRelativePath',
    'baseXctestrunRelativePath',
    'artifactXctestrunRelativePath',
    'baseXctestrunSha256',
    'knownReferencesResolvedAfterCopy',
    'referencedProducts',
    'contentSha256',
    'fileCount',
    'byteCount',
    'entries',
  ]);
  literal(products.rootRelativePath, 'Build/Products');
  literal(products.knownReferencesResolvedAfterCopy, true);
  const baseXctestrunRelativePath = safeRelativePath(products.baseXctestrunRelativePath);
  if (!baseXctestrunRelativePath.endsWith('.xctestrun')) throw invalidManifest();
  const artifactXctestrunRelativePath = safeRelativePath(products.artifactXctestrunRelativePath);
  literal(artifactXctestrunRelativePath, `Build/Products/${baseXctestrunRelativePath}`);
  const referencedProducts = decodeSortedPaths(products.referencedProducts, MAX_REFERENCES);
  const entries = decodeEntries(products.entries);
  const productEntries = entries.map((entry) => {
    const prefix = 'Build/Products/';
    if (!entry.path.startsWith(prefix)) throw invalidManifest();
    return { ...entry, path: entry.path.slice(prefix.length) };
  });
  const calculatedContentSha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(productEntries))
    .digest('hex');
  literal(digest(products.contentSha256), calculatedContentSha256);
  const files = entries.filter(
    (entry): entry is Extract<LocalAppleRunnerArtifactManifestEntry, { kind: 'file' }> =>
      entry.kind === 'file',
  );
  literal(integer(products.fileCount, 1, MAX_ENTRIES), files.length);
  literal(
    integer(products.byteCount, 0, Number.MAX_SAFE_INTEGER),
    files.reduce((sum, entry) => sum + entry.size, 0),
  );
  const baseEntry = files.find((entry) => entry.path === artifactXctestrunRelativePath);
  if (!baseEntry) throw invalidManifest();
  literal(digest(products.baseXctestrunSha256), baseEntry.sha256);
  const entryPaths = new Set(entries.map((entry) => entry.path));
  for (const reference of referencedProducts) {
    if (!entryPaths.has(`Build/Products/${reference}`)) throw invalidManifest();
  }
  return Object.freeze({
    format: 'agent-device-apple-runner-artifact-v1',
    schemaVersion: 1,
    schemaSha256: LOCAL_APPLE_RUNNER_ARTIFACT_MANIFEST_SCHEMA_SHA256,
    publicationState: 'local_unpublished',
    activationEligible: false,
    agentDeviceVersion,
    variant,
    producer: Object.freeze({
      closure: 'loaded producer module graph',
      closureSha256: digest(producer.closureSha256),
    }),
    source: Object.freeze({
      checkoutRunnerTreeSha256: digest(source.checkoutRunnerTreeSha256),
      frozenRunnerTreeSha256: digest(source.frozenRunnerTreeSha256),
    }),
    build: Object.freeze({
      action: 'build-for-testing',
      destinationClass: variant,
      publicSettings: Object.freeze({
        appBundleId: boundedString(publicSettings.appBundleId, MAX_IDENTITY_BYTES),
        testBundleId: boundedString(publicSettings.testBundleId, MAX_IDENTITY_BYTES),
        architectures:
          publicSettings.architectures === null
            ? null
            : boundedString(publicSettings.architectures, MAX_IDENTITY_BYTES),
      }),
      closedRequestSha256: digest(build.closedRequestSha256),
    }),
    toolchain: Object.freeze({
      xcodeVersion: boundedString(toolchain.xcodeVersion, MAX_IDENTITY_BYTES),
      xcodeBuild: boundedString(toolchain.xcodeBuild, MAX_IDENTITY_BYTES),
      sdk,
      sdkVersion: boundedString(toolchain.sdkVersion, MAX_IDENTITY_BYTES),
      sdkBuild: boundedString(toolchain.sdkBuild, MAX_IDENTITY_BYTES),
    }),
    products: Object.freeze({
      rootRelativePath: 'Build/Products',
      baseXctestrunRelativePath,
      artifactXctestrunRelativePath,
      baseXctestrunSha256: baseEntry.sha256,
      knownReferencesResolvedAfterCopy: true,
      referencedProducts,
      contentSha256: calculatedContentSha256,
      fileCount: files.length,
      byteCount: files.reduce((sum, entry) => sum + entry.size, 0),
      entries,
    }),
  });
}

function decodeEntries(value: unknown): readonly LocalAppleRunnerArtifactManifestEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENTRIES) {
    throw invalidManifest();
  }
  let previous = '';
  return Object.freeze(
    value.map((raw) => {
      const candidate = record(raw);
      const kind = oneOf(candidate.kind, ['directory', 'file'] as const);
      const keys =
        kind === 'file' ? ['kind', 'path', 'mode', 'size', 'sha256'] : ['kind', 'path', 'mode'];
      exactKeys(candidate, keys);
      const entryPath = safeRelativePath(candidate.path);
      if (previous && previous >= entryPath) throw invalidManifest();
      previous = entryPath;
      const mode = integer(candidate.mode, 0, 0o777);
      return Object.freeze(
        kind === 'file'
          ? {
              kind,
              path: entryPath,
              mode,
              size: integer(candidate.size, 0, Number.MAX_SAFE_INTEGER),
              sha256: digest(candidate.sha256),
            }
          : { kind, path: entryPath, mode },
      );
    }),
  );
}

function decodeSortedPaths(value: unknown, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalidManifest();
  let previous = '';
  return Object.freeze(
    value.map((raw) => {
      const current = safeRelativePath(raw);
      if (previous && previous >= current) throw invalidManifest();
      previous = current;
      return current;
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function strictObject(required: readonly string[], properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, required, properties };
}

function identitySchema() {
  return { type: 'string', minLength: 1, maxLength: MAX_IDENTITY_BYTES };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const candidate = record(value);
  exactKeys(candidate, keys);
  return candidate;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidManifest();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidManifest();
  }
}

function literal<T extends string | number | boolean>(value: unknown, expected: T): T {
  if (value !== expected) throw invalidManifest();
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw invalidManifest();
  return value as T[number];
}

function boundedString(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw invalidManifest();
  }
  return value;
}

function safeRelativePath(value: unknown): string {
  const candidate = boundedString(value, MAX_PATH_BYTES);
  if (
    candidate.startsWith('/') ||
    candidate.includes('\\') ||
    candidate.includes('\0') ||
    candidate.split('/').some((component) => !component || component === '.' || component === '..')
  ) {
    throw invalidManifest();
  }
  return candidate;
}

function digest(value: unknown): string {
  const candidate = boundedString(value, 64);
  if (!/^[0-9a-f]{64}$/.test(candidate)) throw invalidManifest();
  return candidate;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidManifest();
  }
  return value as number;
}

function invalidManifest(cause?: unknown): AppleRunnerArtifactBuildError {
  return new AppleRunnerArtifactBuildError(
    'manifest_invalid',
    'Invalid local Apple runner artifact manifest',
    cause,
  );
}
