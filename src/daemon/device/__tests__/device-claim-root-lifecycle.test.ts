import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...actual,
    runCmdDetachedMonitored: vi.fn(),
    runCmdSync: vi.fn(() => ({ exitCode: 1, stdout: '', stderr: '' })),
  };
});

vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

const transport = vi.hoisted(() => ({
  canConnect: vi.fn(async () => true),
  sendRequest: vi.fn(async () => ({ ok: true, data: { via: 'injected-transport' } })),
}));

vi.mock('../../../daemon-client/daemon-client-transport.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../daemon-client/daemon-client-transport.ts')>();
  return {
    ...actual,
    canConnect: transport.canConnect,
    sendRequest: transport.sendRequest,
  };
});

import { sendToDaemon } from '../../../daemon-client/daemon-client.ts';
import { computeDaemonCodeSignature } from '@agent-device/host-kit/code-signature';
import { openDeviceClaimRoot } from '../../../device-claim-root.ts';
import { resolveDaemonPaths, type DaemonPaths } from '../../../daemon-resolution.ts';
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { findProjectRoot, readVersion } from '@agent-device/host-kit/version';

const mockRunCmdDetached = vi.mocked(runCmdDetachedMonitored);
const FIXTURE_DAEMON_PID = 999_997;

afterEach(() => {
  mockRunCmdDetached.mockReset();
  transport.canConnect.mockReset();
  transport.canConnect.mockResolvedValue(true);
  transport.sendRequest.mockReset();
  transport.sendRequest.mockResolvedValue({ ok: true, data: { via: 'injected-transport' } });
  vi.unstubAllEnvs();
});

function tempDir(prefix: string): string {
  return mkdtempForTestSync(prefix);
}

function currentDaemonCodeSignature(): string {
  const root = findProjectRoot();
  const distPath = path.join(root, 'dist', 'src', 'internal', 'daemon.js');
  const sourcePath = path.join(root, 'src', 'daemon.ts');
  const entryPath =
    process.execArgv.includes('--experimental-strip-types') || !fs.existsSync(distPath)
      ? sourcePath
      : distPath;
  return computeDaemonCodeSignature(entryPath, root);
}

function writeDaemonAuthority(paths: DaemonPaths, claimRootId: string): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.lockPath,
    `${JSON.stringify({
      pid: FIXTURE_DAEMON_PID,
      processStartTime: `fixture-start-${FIXTURE_DAEMON_PID}`,
      startedAt: Date.now(),
    })}\n`,
  );
  fs.writeFileSync(
    paths.infoPath,
    `${JSON.stringify({
      token: 'local-secret',
      pid: FIXTURE_DAEMON_PID,
      processStartTime: `fixture-start-${FIXTURE_DAEMON_PID}`,
      version: readVersion(),
      codeSignature: currentDaemonCodeSignature(),
      transport: 'http',
      httpPort: 8123,
      deviceClaimRootId: claimRootId,
    })}\n`,
  );
}

test('daemon launch receives the typed immutable device-claim root', async () => {
  const stateDir = tempDir('agent-device-daemon-typed-claim-root-');
  const claimsBase = tempDir('agent-device-typed-claims-');
  const claimsDir = path.join(claimsBase, 'claims');
  const paths = resolveDaemonPaths(stateDir);
  vi.stubEnv('AGENT_DEVICE_CLAIMS_DIR', '/conflicting/environment/root');
  let launchArgs: string[] = [];

  mockRunCmdDetached.mockImplementation((_command, args, options) => {
    launchArgs = [...args];
    assert.equal(options?.env?.AGENT_DEVICE_CLAIMS_DIR, undefined);
    writeDaemonAuthority(paths, openDeviceClaimRoot(claimsDir).id);
    return { pid: FIXTURE_DAEMON_PID, exited: new Promise(() => {}) };
  });

  try {
    const response = await sendToDaemon(
      {
        session: 'default',
        command: 'typed-claim-root-smoke',
        positionals: [],
        flags: { stateDir, daemonTransport: 'http' },
        meta: { requestId: 'req-typed-claim-root' },
      },
      { deviceClaimsDir: claimsDir },
    );

    assert.deepEqual(response, { ok: true, data: { via: 'injected-transport' } });
    assert.deepEqual(launchArgs.slice(-2), [
      '--device-claims-dir',
      openDeviceClaimRoot(claimsDir).path,
    ]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claimsBase, { recursive: true, force: true });
  }
});

test('reachable daemon bound to another explicit claim root is refused', async () => {
  const stateDir = tempDir('agent-device-daemon-claim-root-mismatch-');
  const claimsBase = tempDir('agent-device-expected-claims-');
  const claimsDir = path.join(claimsBase, 'claims');
  const otherClaimsBase = tempDir('agent-device-other-claims-');
  const paths = resolveDaemonPaths(stateDir);
  writeDaemonAuthority(paths, openDeviceClaimRoot(path.join(otherClaimsBase, 'claims')).id);

  try {
    await assert.rejects(
      sendToDaemon(
        {
          session: 'default',
          command: 'claim-root-mismatch-smoke',
          positionals: [],
          flags: { stateDir, daemonTransport: 'http' },
          meta: { requestId: 'req-claim-root-mismatch' },
        },
        { deviceClaimsDir: claimsDir },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.reason, 'device_claim_root_mismatch');
        return true;
      },
    );
    assert.equal(mockRunCmdDetached.mock.calls.length, 0);
    assert.equal(transport.canConnect.mock.calls.length, 1);
    assert.equal(transport.sendRequest.mock.calls.length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claimsBase, { recursive: true, force: true });
    fs.rmSync(otherClaimsBase, { recursive: true, force: true });
  }
});
