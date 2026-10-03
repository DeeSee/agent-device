import type { Mock } from 'vitest';

import { loadedAgentDeviceVersion } from '../runner-package-identity.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, vi } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { makeRunnerArtifactTreeRemovable } from '../runner-local-artifact-storage.ts';

import {
  captureRunnerBuildSources,
  frozenRunnerBuildSourcesSha256,
} from '../runner-local-artifact-source-set.ts';

import type {
  AppleRunnerArtifactBuildEffects,
  AppleRunnerArtifactBuildInput,
  LocalAppleRunnerArtifactOptions,
  LocalAppleRunnerWorkspace,
} from '../runner-local-artifact-contract.ts';
const packageIdentityFixture = vi.hoisted(() => ({
  sourceSha256: undefined as string | undefined,
}));

vi.mock('../runner-package-identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-package-identity.ts')>();
  return {
    ...actual,
    loadedAgentDeviceRunnerSourceSha256: () =>
      packageIdentityFixture.sourceSha256 ?? actual.loadedAgentDeviceRunnerSourceSha256(),
  };
});

beforeEach(() => {
  packageIdentityFixture.sourceSha256 = undefined;
});

const { mockGetFreePort }: { mockGetFreePort: Mock } = vi.hoisted(() => ({
  mockGetFreePort: vi.fn(async () => 8123),
}));

vi.mock('../runner-io.ts', async () => {
  const actual = await vi.importActual<typeof import('../runner-io.ts')>('../runner-io.ts');
  return { ...actual, getFreePort: mockGetFreePort };
});

type MutableCandidate = Record<string, unknown> & {
  schemaSha256: string;
  build: { publicSettings: { architectures: string | null } };
  products: {
    entries: Array<Record<string, unknown>>;
    referencedProducts: string[];
    byteCount: number;
    contentSha256: string;
  };
};

function fakeEffects(
  build: (input: AppleRunnerArtifactBuildInput) => void | Promise<void>,
): AppleRunnerArtifactBuildEffects {
  return {
    build: async (input) => build(input),
    inspectToolchain: async (input) => ({
      xcodeVersion: '26.5',
      xcodeBuild: '17F42',
      sdk: input.variant === 'device' ? 'iphoneos' : 'iphonesimulator',
      sdkVersion: '26.5',
      sdkBuild: '23F73',
    }),
    validateXctestrun: async (xctestrunPath) => {
      const products = path.dirname(xctestrunPath);
      return [
        path.join(products, 'Debug-target/Runner.app'),
        path.join(products, 'Debug-target/App.app'),
      ];
    },
  };
}

function buildOptions(
  sourceRoot: string,
  outputParent: string,
  variant: 'device' | 'simulator',
  destination = variant === 'device' ? 'generic/platform=iOS' : 'generic/platform=iOS Simulator',
): LocalAppleRunnerArtifactOptions {
  const simulator = variant === 'simulator';
  return {
    sourceRoot,
    outputParent,
    variant,
    destination,
    environment: { PATH: '/usr/bin:/bin', DEVELOPER_DIR: '/Applications/Xcode.app/Developer' },
    settings: {
      appBundleId: 'com.example.runner',
      testBundleId: 'com.example.runner.uitests',
      architectures: 'arm64',
      developmentTeam: simulator ? null : 'SECRET_TEAM',
      codeSignIdentity: simulator ? null : 'SECRET_CERTIFICATE',
      codeSignStyle: simulator ? null : 'Manual',
      provisioningProfileSpecifier: simulator ? null : 'SECRET_PROFILE',
      codeSigningAllowed: simulator ? null : 'YES',
      codeSigningRequired: simulator ? null : 'YES',
    },
  };
}

function createSourceRoot(version = '9.8.7'): string {
  const root = mkdtempForTestSync('agent-device-runner-source-');
  fs.mkdirSync(path.join(root, 'apple/snapshot-presentation'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'apple/snapshot-presentation/Package.swift'),
    '// swift-tools-version: 6.0\n',
  );
  fs.mkdirSync(path.join(root, 'apple/runner/AgentDeviceRunner'), { recursive: true });
  writePackageVersion(root, version);
  fs.writeFileSync(
    path.join(root, 'apple/runner/AgentDeviceRunner/Runner.swift'),
    'final class Runner {}\n',
  );
  return root;
}

function createInstalledSourceRoot(): string {
  const root = createSourceRoot(loadedAgentDeviceVersion());
  fs.writeFileSync(
    path.join(root, 'apple/runner/AgentDeviceRunner/Runner.swift'),
    'final class InstalledRunner {}\n',
  );
  packageIdentityFixture.sourceSha256 = frozenRunnerBuildSourcesSha256(
    captureRunnerBuildSources(root),
  );
  return root;
}

function testWorkspaceFactory(parent: string, creations: string[] = []) {
  return {
    async create() {
      const root = fs.mkdtempSync(path.join(parent, 'workspace-'));
      creations.push(root);
      let closed = false;
      return {
        async withRoot<T>(operation: (root: string) => Promise<T>): Promise<T> {
          if (closed) throw new Error('workspace closed');
          return await operation(root);
        },
        async close() {
          if (!closed) {
            makeRunnerArtifactTreeRemovable(root);
            fs.rmSync(root, { recursive: true });
          }
          closed = true;
          return { kind: 'closed' as const };
        },
      };
    },
  };
}

function persistentWorkspaceFactory(root: string) {
  return {
    async create(): Promise<LocalAppleRunnerWorkspace> {
      let closed = false;
      return {
        async withRoot<T>(operation: (root: string) => Promise<T>): Promise<T> {
          if (closed) throw new Error('workspace closed');
          return await operation(root);
        },
        async close() {
          closed = true;
          return { kind: 'closed' as const };
        },
      };
    },
  };
}

function writePackageVersion(root: string, version: string): void {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'agent-device', version }),
  );
}

function writeProducts(derivedData: string, platform: 'iphoneos' | 'iphonesimulator'): string {
  const products = path.join(derivedData, 'Build/Products');
  fs.mkdirSync(path.join(products, 'Debug-target/Runner.app/PlugIns/RunnerTests.xctest'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(products, 'Debug-target/App.app'), { recursive: true });
  fs.writeFileSync(
    path.join(
      products,
      `AgentDeviceRunner_AgentDeviceRunnerUITests_${platform}26.5-arm64.xctestrun`,
    ),
    xctestrunXml(),
  );
  fs.writeFileSync(path.join(products, 'Debug-target/Runner.app/Runner'), 'runner');
  fs.writeFileSync(path.join(products, 'payload.bin'), 'payload');
  return products;
}

function xctestrunXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>TestConfigurations</key><array><dict>
<key>TestTargets</key><array><dict>
<key>BlueprintName</key><string>RunnerTests</string>
<key>TestHostBundleIdentifier</key><string>com.example.RunnerTests.xctrunner</string>
<key>TestHostPath</key><string>__TESTROOT__/Debug-target/Runner.app</string>
<key>TestBundlePath</key><string>__TESTHOST__/PlugIns/RunnerTests.xctest</string>
<key>UITargetAppPath</key><string>__TESTROOT__/Debug-target/App.app</string>
<key>DependentProductPaths</key><array><string>__TESTROOT__/Debug-target/App.app</string></array>
</dict></array></dict></array></dict></plist>\n`;
}

function sha256(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
export const testFixture = {
  packageIdentityFixture,
  mockGetFreePort,
  fakeEffects,
  buildOptions,
  createSourceRoot,
  createInstalledSourceRoot,
  testWorkspaceFactory,
  persistentWorkspaceFactory,
  writePackageVersion,
  writeProducts,
  xctestrunXml,
  sha256,
};
export type { MutableCandidate };
