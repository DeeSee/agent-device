import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  clearDaemonShutdownReport,
  DAEMON_SHUTDOWN_REPORT_SCHEMA_VERSION,
  parseDaemonShutdownReport,
  readDaemonShutdownReport,
  writeDaemonShutdownReport,
} from '../daemon-shutdown-report.ts';
import { LeaseRegistry } from '../daemon/lease-registry.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

const claim = {
  deviceKey: 'local:android:none:emulator-5554',
  session: 'default',
  platform: 'android',
  deviceId: 'emulator-5554',
};

const daemon = {
  pid: 123,
  processStartTime: 'start-123',
  version: '0.20.10',
  codeSignature: 'graph:1:abc',
  deviceClaimRootId: 'claims-root',
};

test('round-trips provider release and device claim records without lease credentials', () => {
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const lease = new LeaseRegistry().allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'limrun',
  });

  try {
    writeDaemonShutdownReport(stateDir, {
      daemon,
      providerReleases: { released: [lease], pending: [lease] },
      claims: { released: [claim], orphaned: [], superseded: [claim], unattributable: [] },
    });

    expect(readDaemonShutdownReport(stateDir)).toEqual({
      schemaVersion: DAEMON_SHUTDOWN_REPORT_SCHEMA_VERSION,
      daemon,
      providerReleases: {
        released: [{ leaseId: lease.leaseId, provider: 'limrun' }],
        pending: [{ leaseId: lease.leaseId, provider: 'limrun' }],
      },
      claims: { released: [claim], orphaned: [], superseded: [claim], unattributable: [] },
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the strict decoder rejects predecessor and extra-field reports', () => {
  expect(parseDaemonShutdownReport({ providerReleases: { released: [], pending: [] } })).toBeNull();
  expect(
    parseDaemonShutdownReport({
      schemaVersion: 2,
      daemon,
      providerReleases: { released: [], pending: [] },
      claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
      legacyFallback: true,
    }),
  ).toBeNull();
});

test('ignores malformed shutdown reports and clear removes a prior report', () => {
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const reportPath = path.join(stateDir, 'daemon-shutdown.json');

  try {
    expect(readDaemonShutdownReport(stateDir)).toBeNull();
    fs.writeFileSync(reportPath, JSON.stringify({ providerReleases: { released: [] } }));
    expect(readDaemonShutdownReport(stateDir)).toBeNull();

    fs.writeFileSync(
      reportPath,
      JSON.stringify({ providerReleases: { released: [{}], pending: [] } }),
    );
    expect(readDaemonShutdownReport(stateDir)).toBeNull();

    clearDaemonShutdownReport(stateDir);
    expect(fs.existsSync(reportPath)).toBe(false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an unattributed predecessor report cannot prove cleanup by this daemon', () => {
  const stateDir = mkdtempForTestSync('agent-device-shutdown-report-');
  const reportPath = path.join(stateDir, 'daemon-shutdown.json');
  const claim = {
    deviceKey: 'local:android:none:emulator-5554',
    session: 'default',
    platform: 'android',
    deviceId: 'emulator-5554',
  };

  try {
    // The shape a previous daemon writes. `unattributable` is additive, so a reader of a report from
    // before it existed must still get every bucket it can describe rather than dropping the section.
    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        providerReleases: { released: [], pending: [] },
        claims: { released: [claim], orphaned: [claim], superseded: [claim] },
      }),
    );

    expect(readDaemonShutdownReport(stateDir)).toBeNull();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
