import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const plistByPath = new Map<string, Record<string, unknown>>();
const TEST_HOST_BUNDLE_ID = 'com.callstack.agentdevice.runner.uitests.xctrunner';

export function clearRunnerArtifactPlistFixtures(): void {
  plistByPath.clear();
}

export function readRunnerArtifactPlistFixture(plistPath: string): Record<string, unknown> | null {
  return plistByPath.get(plistPath) ?? null;
}

export function writeXctestrunFixture(
  xctestrunPath: string,
  options: { projectRoot: string; productRelativePaths: string[] },
): void {
  const testHostRelativePath = options.productRelativePaths.find((candidate) =>
    candidate.endsWith('.app'),
  );
  assert.ok(testHostRelativePath, 'fixture requires a test-host app');
  const entries = options.productRelativePaths
    .map((relativePath) => `        <string>__TESTROOT__/${relativePath}</string>`)
    .join('\n');
  fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
  fs.writeFileSync(
    xctestrunPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProjectRootHint</key>
  <string>${options.projectRoot}</string>
  <key>ProductPaths</key>
  <array>
${entries}
  </array>
</dict>
</plist>`,
    'utf8',
  );
  plistByPath.set(xctestrunPath, {
    ProjectRootHint: options.projectRoot,
    ProductPaths: options.productRelativePaths.map(
      (relativePath) => `__TESTROOT__/${relativePath}`,
    ),
    TestConfigurations: [
      {
        TestTargets: [
          {
            TestHostBundleIdentifier: TEST_HOST_BUNDLE_ID,
            TestHostPath: `__TESTROOT__/${testHostRelativePath}`,
          },
        ],
      },
    ],
  });
  plistByPath.set(path.join(path.dirname(xctestrunPath), testHostRelativePath, 'Info.plist'), {
    CFBundleIdentifier: TEST_HOST_BUNDLE_ID,
  });
}
