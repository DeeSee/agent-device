import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';
import { resolveRunnerLaunchSelection } from '../runner-launch-identity.ts';

const HOST_BUNDLE_ID = 'com.example.AgentDeviceRunnerUITests.xctrunner';

test('external runner identity is deterministic and bound to the coherent test host', async () => {
  const fixture = makeFixture();
  const first = await resolveFixture(fixture);
  const second = await resolveFixture(fixture);

  expect(first.identity).toEqual(second.identity);
  expect(first.identity.testHostContainerBundleId).toBe(HOST_BUNDLE_ID);

  fs.appendFileSync(fixture.xctestrunPath, '\nchanged');
  const changed = await resolveFixture(fixture);
  expect(changed.identity.selectorFingerprint).not.toBe(first.identity.selectorFingerprint);
});

test('a preconfigured external runner is identified without trusting its runtime port', async () => {
  const root = mkdtempForTestSync('agent-device-prepared-launch-identity-');
  const xctestrunPath = path.join(root, 'AgentDeviceRunner.prepared.v1.xctestrun');
  fs.writeFileSync(xctestrunPath, preconfiguredXctestrunXml(HOST_BUNDLE_ID, 8123));
  const infoPath = path.join(root, 'Runner-0.app', 'Info.plist');
  const plistReads: string[] = [];
  const provider = createLocalAppleToolProvider({
    plist: {
      readJson: async (plistPath) => {
        plistReads.push(plistPath);
        if (plistPath === xctestrunPath) return xctestrunTargets(HOST_BUNDLE_ID);
        return plistPath === infoPath ? { CFBundleIdentifier: HOST_BUNDLE_ID } : null;
      },
    },
  });

  const selection = await withAppleToolProvider(
    provider,
    async () =>
      await resolveRunnerLaunchSelection(IOS_SIMULATOR, {
        iosXctestrunFile: xctestrunPath,
        iosXctestDerivedDataPath: path.join(root, 'DerivedData'),
        iosXctestEnvDir: root,
      }),
  );

  expect(selection).not.toHaveProperty('preparedEnvironment');
  expect(selection.identity.testHostContainerBundleId).toBe(HOST_BUNDLE_ID);
  expect(plistReads).toEqual([xctestrunPath, infoPath]);
});

test.each([
  {
    name: 'no test target',
    xctestrun: { TestConfigurations: [{ TestTargets: [] }] },
    hostBundleIds: [HOST_BUNDLE_ID],
    reason: 'runner_identity_unbound',
  },
  {
    name: 'ambiguous test hosts',
    xctestrun: xctestrunTargets(HOST_BUNDLE_ID, 'com.example.other.xctrunner'),
    hostBundleIds: [HOST_BUNDLE_ID, 'com.example.other.xctrunner'],
    reason: 'runner_identity_unbound',
  },
  {
    name: 'product bundle mismatch',
    xctestrun: xctestrunTargets(HOST_BUNDLE_ID),
    hostBundleIds: ['com.example.wrong.xctrunner'],
    reason: 'runner_identity_incoherent',
  },
  {
    name: 'non-relocatable product path',
    xctestrun: {
      TestConfigurations: [
        {
          TestTargets: [
            {
              TestHostBundleIdentifier: HOST_BUNDLE_ID,
              TestHostPath: '/mutable/cache/Runner.app',
            },
          ],
        },
      ],
    },
    hostBundleIds: [HOST_BUNDLE_ID],
    reason: 'runner_identity_unbound',
  },
])('refuses $name before runner effects', async ({ xctestrun, hostBundleIds, reason }) => {
  const fixture = makeFixture(xctestrun, hostBundleIds);
  await expect(resolveFixture(fixture)).rejects.toMatchObject({ details: { reason } });
});

function makeFixture(
  xctestrun: Record<string, unknown> = xctestrunTargets(HOST_BUNDLE_ID),
  hostBundleIds: readonly string[] = [HOST_BUNDLE_ID],
) {
  const root = mkdtempForTestSync('agent-device-launch-identity-');
  const xctestrunPath = path.join(root, 'AgentDeviceRunner.xctestrun');
  fs.writeFileSync(xctestrunPath, 'opaque plist bytes');
  const plistByPath = new Map<string, Record<string, unknown>>([[xctestrunPath, xctestrun]]);
  hostBundleIds.forEach((bundleId, index) => {
    plistByPath.set(path.join(root, `Runner-${index}.app`, 'Info.plist'), {
      CFBundleIdentifier: bundleId,
    });
  });
  return { xctestrunPath, plistByPath };
}

async function resolveFixture(fixture: ReturnType<typeof makeFixture>) {
  const provider = createLocalAppleToolProvider({
    plist: {
      readJson: async (plistPath) => fixture.plistByPath.get(plistPath) ?? null,
    },
  });
  return await withAppleToolProvider(
    provider,
    async () =>
      await resolveRunnerLaunchSelection(IOS_SIMULATOR, {
        iosXctestrunFile: fixture.xctestrunPath,
        iosXctestDerivedDataPath: path.join(path.dirname(fixture.xctestrunPath), 'DerivedData'),
        iosXctestEnvDir: path.dirname(fixture.xctestrunPath),
      }),
  );
}

function xctestrunTargets(...bundleIds: string[]): Record<string, unknown> {
  return {
    TestConfigurations: [
      {
        TestTargets: bundleIds.map((bundleId, index) => ({
          TestHostBundleIdentifier: bundleId,
          TestHostPath: `__TESTROOT__/Runner-${index}.app`,
        })),
      },
    ],
  };
}

function xctestrunXml(bundleId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>TestConfigurations</key><array><dict><key>TestTargets</key><array><dict>
<key>EnvironmentVariables</key><dict/><key>TestingEnvironmentVariables</key><dict/>
<key>UITestEnvironmentVariables</key><dict/><key>UITargetAppEnvironmentVariables</key><dict/>
<key>TestBundlePath</key><string>__TESTHOST__/PlugIns/RunnerTests.xctest</string>
<key>TestHostBundleIdentifier</key><string>${bundleId}</string>
<key>TestHostPath</key><string>__TESTROOT__/Runner.app</string>
</dict></array></dict></array></dict></plist>`;
}

function preconfiguredXctestrunXml(bundleId: string, port: number): string {
  const environment = `<dict><key>AGENT_DEVICE_RUNNER_ENV_VERSION</key><string>1</string>
<key>AGENT_DEVICE_RUNNER_PORT</key><string>${port}</string></dict>`;
  return xctestrunXml(bundleId).replaceAll('<dict/>', environment);
}
