import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { verifyAppleRunnerXctestrun } from '../runner-prepared-artifact.ts';

test('verification binds an unprepared relocatable product tree without runtime state', () => {
  const fixture = createFixture();

  const receipt = verifyAppleRunnerXctestrun({
    productsRoot: fixture.productsRoot,
    baseXctestrunRelativePath: fixture.baseRelativePath,
    expectedBaseSha256: sha256(fixture.base),
  });

  expect(receipt).toMatchObject({
    schemaVersion: 1,
    base: {
      relativePath: fixture.baseRelativePath,
      rawSha256: sha256(fixture.base),
      size: fixture.base.length,
    },
    structuralIdentity: {
      declaredTestHostContainerBundleId: 'com.example.AgentDeviceRunnerUITests.xctrunner',
    },
    productsRootIdentity: { device: expect.any(String), inode: expect.any(String) },
  });
  expect(fs.readdirSync(fixture.productsRoot).sort()).toEqual([
    fixture.baseRelativePath,
    'Debug-iphoneos',
  ]);
});

test('verification rejects stale digests and missing referenced products', () => {
  const stale = createFixture();
  expect(() =>
    verifyAppleRunnerXctestrun({
      productsRoot: stale.productsRoot,
      baseXctestrunRelativePath: stale.baseRelativePath,
      expectedBaseSha256: '0'.repeat(64),
    }),
  ).toThrowError(
    expect.objectContaining({ details: { reason: 'runner_preparation_base_changed' } }),
  );

  const missing = createFixture();
  fs.rmSync(path.join(missing.productsRoot, 'Debug-iphoneos/AgentDeviceRunner.app'), {
    recursive: true,
  });
  expect(() =>
    verifyAppleRunnerXctestrun({
      productsRoot: missing.productsRoot,
      baseXctestrunRelativePath: missing.baseRelativePath,
      expectedBaseSha256: sha256(missing.base),
    }),
  ).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'runner_preparation_product_missing' }),
    }),
  );
});

test('coverage build metadata stays digest-bound without becoming a launch dependency', () => {
  const source = xctestrunXml().replace(
    '</dict></plist>',
    '<key>CodeCoverageBuildableInfos</key><array><dict><key>ProductPaths</key><array>' +
      '<string>__TESTROOT__/Debug-iphoneos/PackageFrameworks/Presentation.framework/Presentation</string>' +
      '</array></dict></array></dict></plist>',
  );
  const fixture = createFixture(source);
  const receipt = verifyAppleRunnerXctestrun({
    productsRoot: fixture.productsRoot,
    baseXctestrunRelativePath: fixture.baseRelativePath,
    expectedBaseSha256: sha256(fixture.base),
  });
  const changed = createFixture(source.replace('Presentation.framework', 'Other.framework'));
  const changedReceipt = verifyAppleRunnerXctestrun({
    productsRoot: changed.productsRoot,
    baseXctestrunRelativePath: changed.baseRelativePath,
    expectedBaseSha256: sha256(changed.base),
  });
  expect(receipt.base.rawSha256).not.toBe(changedReceipt.base.rawSha256);
  expect(receipt.base.semanticSha256).not.toBe(changedReceipt.base.semanticSha256);
  expect(receipt.structuralIdentity).toEqual(changedReceipt.structuralIdentity);

  const missingDependency = createFixture(
    source.replace(
      '<key>TestBundlePath</key>',
      '<key>DependentProductPaths</key><array>' +
        '<string>__TESTROOT__/Debug-iphoneos/Runtime.framework</string></array><key>TestBundlePath</key>',
    ),
  );
  expect(() =>
    verifyAppleRunnerXctestrun({
      productsRoot: missingDependency.productsRoot,
      baseXctestrunRelativePath: missingDependency.baseRelativePath,
      expectedBaseSha256: sha256(missingDependency.base),
    }),
  ).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'runner_preparation_product_missing' }),
    }),
  );
});

test('verification rejects symlinked products and reusable port-bound plists', () => {
  const symlinked = createFixture();
  const productPath = path.join(symlinked.productsRoot, 'Debug-iphoneos/AgentDeviceRunner.app');
  fs.rmSync(productPath, { recursive: true });
  fs.symlinkSync(mkdtempForTestSync('agent-device-product-outside-'), productPath);
  expect(() =>
    verifyAppleRunnerXctestrun({
      productsRoot: symlinked.productsRoot,
      baseXctestrunRelativePath: symlinked.baseRelativePath,
      expectedBaseSha256: sha256(symlinked.base),
    }),
  ).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'runner_preparation_product_missing' }),
    }),
  );

  const prepared = createFixture(preparedXctestrunXml());
  expect(() =>
    verifyAppleRunnerXctestrun({
      productsRoot: prepared.productsRoot,
      baseXctestrunRelativePath: prepared.baseRelativePath,
      expectedBaseSha256: sha256(prepared.base),
    }),
  ).toThrowError(
    expect.objectContaining({ details: { reason: 'runner_preparation_already_prepared' } }),
  );
});

test('verification cancellation creates no output', () => {
  const fixture = createFixture();
  const cancellation = new AbortController();
  cancellation.abort('test cancellation');

  expect(() =>
    verifyAppleRunnerXctestrun({
      productsRoot: fixture.productsRoot,
      baseXctestrunRelativePath: fixture.baseRelativePath,
      expectedBaseSha256: sha256(fixture.base),
      signal: cancellation.signal,
    }),
  ).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'runner_preparation_canceled' }),
    }),
  );
  expect(fs.readdirSync(fixture.productsRoot).sort()).toEqual([
    fixture.baseRelativePath,
    'Debug-iphoneos',
  ]);
});

function createFixture(source: string = xctestrunXml()) {
  const productsRoot = mkdtempForTestSync('agent-device-verified-artifact-');
  const baseRelativePath = 'Base.xctestrun';
  const base = Buffer.from(source);
  fs.mkdirSync(
    path.join(
      productsRoot,
      'Debug-iphoneos/AgentDeviceRunnerUITests-Runner.app/PlugIns/AgentDeviceRunnerUITests.xctest',
    ),
    { recursive: true },
  );
  fs.mkdirSync(path.join(productsRoot, 'Debug-iphoneos/AgentDeviceRunner.app'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(productsRoot, baseRelativePath), base);
  return { productsRoot, baseRelativePath, base };
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function xctestrunXml(environment: string = '<dict/>'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>TestConfigurations</key><array><dict><key>TestTargets</key><array><dict>
<key>EnvironmentVariables</key>${environment}<key>TestingEnvironmentVariables</key>${environment}
<key>UITestEnvironmentVariables</key>${environment}<key>UITargetAppEnvironmentVariables</key>${environment}
<key>TestBundlePath</key><string>__TESTHOST__/PlugIns/AgentDeviceRunnerUITests.xctest</string>
<key>TestHostBundleIdentifier</key><string>com.example.AgentDeviceRunnerUITests.xctrunner</string>
<key>TestHostPath</key><string>__TESTROOT__/Debug-iphoneos/AgentDeviceRunnerUITests-Runner.app</string>
<key>UITargetAppPath</key><string>__TESTROOT__/Debug-iphoneos/AgentDeviceRunner.app</string>
<key>PreferredScreenCaptureFormat</key><string>screenshots</string>
<key>SystemAttachmentLifetime</key><string>keepNever</string>
<key>UserAttachmentLifetime</key><string>keepNever</string>
</dict></array></dict></array></dict></plist>`;
}

function preparedXctestrunXml(): string {
  return xctestrunXml(
    '<dict><key>AGENT_DEVICE_RUNNER_ENV_VERSION</key><string>1</string>' +
      '<key>AGENT_DEVICE_RUNNER_PORT</key><string>8123</string></dict>',
  );
}
