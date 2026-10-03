export type AppleRunnerArtifactVariant = 'device' | 'simulator';

export type AppleRunnerArtifactBuildFailureCode =
  | 'invalid_options'
  | 'source_invalid'
  | 'runner_source_changed'
  | 'build_failed'
  | 'toolchain_invalid'
  | 'xctestrun_missing'
  | 'xctestrun_invalid'
  | 'manifest_invalid'
  | 'artifact_version_mismatch'
  | 'artifact_source_mismatch'
  | 'artifact_variant_mismatch'
  | 'materialization_canceled'
  | 'materialization_cleanup_unresolved'
  | 'product_symlink_refused'
  | 'product_hardlink_refused'
  | 'product_special_file_refused'
  | 'product_copy_changed'
  | 'publication_conflict'
  | 'publication_unresolved'
  | 'publication_failed';

export class AppleRunnerArtifactBuildError extends Error {
  readonly code: AppleRunnerArtifactBuildFailureCode;
  readonly cause?: unknown;

  constructor(code: AppleRunnerArtifactBuildFailureCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'AppleRunnerArtifactBuildError';
    this.code = code;
    this.cause = cause;
  }
}

export type AppleRunnerArtifactToolchain = Readonly<{
  xcodeVersion: string;
  xcodeBuild: string;
  sdk: 'iphoneos' | 'iphonesimulator';
  sdkVersion: string;
  sdkBuild: string;
}>;

export type AppleRunnerArtifactBuildInput = Readonly<{
  sourceRoot: string;
  derivedData: string;
  destination: string;
  variant: AppleRunnerArtifactVariant;
  environment: Readonly<NodeJS.ProcessEnv>;
  settings: Readonly<{
    appBundleId: string;
    testBundleId: string;
    architectures: string | null;
    developmentTeam: string | null;
    codeSignIdentity: string | null;
    codeSignStyle: string | null;
    provisioningProfileSpecifier: string | null;
    codeSigningAllowed: string | null;
    codeSigningRequired: string | null;
  }>;
}>;

export type AppleRunnerArtifactBuildSettings = AppleRunnerArtifactBuildInput['settings'];

export type LocalAppleRunnerArtifactManifestEntry =
  | Readonly<{
      kind: 'directory';
      path: string;
      mode: number;
    }>
  | Readonly<{
      kind: 'file';
      path: string;
      mode: number;
      size: number;
      sha256: string;
    }>;

export type LocalAppleRunnerArtifactManifest = Readonly<{
  format: 'agent-device-apple-runner-artifact-v1';
  schemaVersion: 1;
  schemaSha256: string;
  publicationState: 'local_unpublished';
  activationEligible: false;
  agentDeviceVersion: string;
  variant: AppleRunnerArtifactVariant;
  producer: Readonly<{
    closure: 'loaded producer module graph';
    closureSha256: string;
  }>;
  source: Readonly<{
    checkoutRunnerTreeSha256: string;
    frozenRunnerTreeSha256: string;
  }>;
  build: Readonly<{
    action: 'build-for-testing';
    destinationClass: AppleRunnerArtifactVariant;
    publicSettings: Readonly<{
      appBundleId: string;
      testBundleId: string;
      architectures: string | null;
    }>;
    closedRequestSha256: string;
  }>;
  toolchain: AppleRunnerArtifactToolchain;
  products: Readonly<{
    rootRelativePath: 'Build/Products';
    baseXctestrunRelativePath: string;
    artifactXctestrunRelativePath: string;
    baseXctestrunSha256: string;
    knownReferencesResolvedAfterCopy: true;
    referencedProducts: readonly string[];
    contentSha256: string;
    fileCount: number;
    byteCount: number;
    entries: readonly LocalAppleRunnerArtifactManifestEntry[];
  }>;
}>;

export type AppleRunnerArtifactBuildEnvironment = Readonly<{
  PATH?: string;
  HOME?: string;
  TMPDIR?: string;
  USER?: string;
  LOGNAME?: string;
  LANG?: string;
  LC_ALL?: string;
  DEVELOPER_DIR?: string;
}>;

export type AppleRunnerArtifactBuildEffects = Readonly<{
  build(input: AppleRunnerArtifactBuildInput): Promise<void>;
  inspectToolchain(input: AppleRunnerArtifactBuildInput): Promise<AppleRunnerArtifactToolchain>;
  validateXctestrun(xctestrunPath: string): Promise<readonly string[] | null>;
}>;

export type LocalAppleRunnerArtifactOptions = Readonly<{
  sourceRoot: string;
  outputParent: string;
  variant: AppleRunnerArtifactVariant;
  destination: string;
  environment: AppleRunnerArtifactBuildEnvironment;
  settings: AppleRunnerArtifactBuildSettings;
}>;

export type LocalAppleRunnerArtifactReceipt = Readonly<{
  schemaVersion: 1;
  agentDeviceVersion: string;
  variant: AppleRunnerArtifactVariant;
  artifactRoot: string;
  productsRoot: string;
  baseXctestrunRelativePath: string;
  artifactXctestrunRelativePath: string;
  baseXctestrunSha256: string;
  productsContentSha256: string;
  producerClosureSha256: string;
  checkoutRunnerTreeSha256: string;
  frozenRunnerTreeSha256: string;
  manifestSchemaSha256: string;
  manifestSha256: string;
  publicationState: 'local_unpublished';
  activationEligible: false;
  cleanupComplete: boolean;
}>;

export type LocalAppleRunnerConfiguration = Readonly<{
  iosXctestrunFile: string;
  iosXctestDerivedDataPath: string;
  iosXctestEnvDir: string;
}>;

export type LocalAppleRunnerConfigurationReceipt = Readonly<{
  kind: 'local_apple_runner_configuration_v2';
  agentDeviceVersion: string;
  targetKind: AppleRunnerArtifactVariant;
  manifestSha256: string;
  productsContentSha256: string;
  baseXctestrunSha256: string;
  runtimeEnvironment: 'per_runner_session_overlay_v1';
  fileCount: number;
  byteCount: number;
}>;

export type LocalAppleRunnerConfigurationLease = Readonly<{
  receipt: LocalAppleRunnerConfigurationReceipt;
  withConfiguration<T>(
    operation: (configuration: LocalAppleRunnerConfiguration) => Promise<T>,
  ): Promise<T>;
  close(): Promise<Readonly<{ kind: 'closed' | 'cleanup_unresolved' }>>;
}>;

export interface LocalAppleRunnerWorkspace {
  /**
   * Idempotently closes the originally created descriptor-owned workspace.
   * It never recursively removes a replacement path and reports unresolved
   * cleanup as a value instead of throwing.
   */
  close(): Promise<Readonly<{ kind: 'closed' | 'cleanup_unresolved' }>>;
  /** The host guarantees this root remains namespace-stable for the callback. */
  withRoot<T>(operation: (root: string) => Promise<T>): Promise<T>;
}

export interface LocalAppleRunnerWorkspaceFactory {
  create(): Promise<LocalAppleRunnerWorkspace>;
}
