import { describe, expect, test } from 'vitest';
import { detectPreparedRunnerEnvironment } from '../runner-prepared-environment.ts';

describe('deprecated reusable XCTest environment detection', () => {
  test('recognizes a coherent legacy marker so trusted artifacts can reject it', () => {
    expect(detectPreparedRunnerEnvironment(Buffer.from(xctestrunXml(8123)))).toEqual({
      version: 1,
      runnerPort: 8123,
    });
  });

  test('an unmarked plist remains eligible for a session-owned overlay', () => {
    expect(detectPreparedRunnerEnvironment(Buffer.from(xctestrunXml()))).toBeUndefined();
  });

  test.each([
    [
      'partial marker',
      (xml: string) => xml.replace(markerEntry('AGENT_DEVICE_RUNNER_PORT', 8123), ''),
    ],
    [
      'conflicting port',
      (xml: string) =>
        xml.replace(
          markerEntry('AGENT_DEVICE_RUNNER_PORT', 8123),
          markerEntry('AGENT_DEVICE_RUNNER_PORT', 8124),
        ),
    ],
    [
      'unknown version',
      (xml: string) =>
        xml.replaceAll(
          markerEntry('AGENT_DEVICE_RUNNER_ENV_VERSION', 1),
          markerEntry('AGENT_DEVICE_RUNNER_ENV_VERSION', 2),
        ),
    ],
    [
      'capture policy mismatch',
      (xml: string) =>
        xml.replace('<string>screenshots</string>', '<string>screenRecording</string>'),
    ],
  ])('refuses a %s marker instead of treating it as a base', (_name, mutate) => {
    expect(() =>
      detectPreparedRunnerEnvironment(Buffer.from(mutate(xctestrunXml(8123)))),
    ).toThrowError(
      expect.objectContaining({
        code: 'COMMAND_FAILED',
        details: expect.objectContaining({ reason: 'runner_prepared_environment_invalid' }),
      }),
    );
  });
});

function markerEntry(key: string, value: number): string {
  return `<key>${key}</key><string>${value}</string>`;
}

function xctestrunXml(port?: number): string {
  const environment =
    port === undefined
      ? '<dict/>'
      : `<dict>${markerEntry('AGENT_DEVICE_RUNNER_ENV_VERSION', 1)}${markerEntry(
          'AGENT_DEVICE_RUNNER_PORT',
          port,
        )}</dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>TestConfigurations</key><array><dict><key>TestTargets</key><array><dict>
<key>EnvironmentVariables</key>${environment}<key>TestingEnvironmentVariables</key>${environment}
<key>UITestEnvironmentVariables</key>${environment}<key>UITargetAppEnvironmentVariables</key>${environment}
<key>TestBundlePath</key><string>__TESTHOST__/PlugIns/AgentDeviceRunnerUITests.xctest</string>
<key>TestHostBundleIdentifier</key><string>com.example.AgentDeviceRunnerUITests.xctrunner</string>
<key>TestHostPath</key><string>__TESTROOT__/Debug-iphoneos/AgentDeviceRunnerUITests-Runner.app</string>
<key>PreferredScreenCaptureFormat</key><string>screenshots</string>
<key>SystemAttachmentLifetime</key><string>keepNever</string>
<key>UserAttachmentLifetime</key><string>keepNever</string>
</dict></array></dict></array></dict></plist>`;
}
