import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';
import {
  cleanupFailedDaemonStartupMetadata,
  cleanupStaleDaemonLockIfSafe,
  recoverDaemonLockHolder,
  resolveDaemonStartupHint,
} from '../daemon-client/daemon-client-metadata.ts';
import { resolveDaemonPaths } from '../daemon-resolution.ts';
import {
  resolveDaemonLockMutationGuardPath,
  tryAcquireDaemonLockMutationGuard,
} from '../daemon-lock-mutation.ts';
import { acquireDaemonLock, type DaemonLockInfo } from '../daemon/server/server-lifecycle.ts';

const existingLock: DaemonLockInfo = {
  pid: 41,
  version: '0.20.10',
  startedAt: 1,
  processStartTime: 'existing-start',
};

test('client preflight retains an unverifiable daemon lock and refuses start', () => {
  const paths = daemonPathsWithLock(existingLock);
  const inspect = vi.fn(() => 'unknown' as const);

  assert.equal(cleanupStaleDaemonLockIfSafe(paths, inspect), false);
  assert.equal(fs.existsSync(paths.lockPath), true);
});

test('client parser normalizes a whitespace lock identity to unverifiable', () => {
  const paths = daemonPathsWithLock({ ...existingLock, processStartTime: '   ' });
  const inspect = vi.fn((_pid: number, expectedStartTime?: string) =>
    expectedStartTime === undefined ? ('unknown' as const) : ('different' as const),
  );

  assert.equal(cleanupStaleDaemonLockIfSafe(paths, inspect), false);
  assert.deepEqual(inspect.mock.calls, [[existingLock.pid, undefined]]);
  assert.equal(fs.existsSync(paths.lockPath), true);
});

test('client preflight removes only a proven stale daemon lock', () => {
  const paths = daemonPathsWithLock(existingLock);
  const inspect = vi.fn(() => 'absent' as const);

  assert.equal(cleanupStaleDaemonLockIfSafe(paths, inspect), true);
  assert.equal(fs.existsSync(paths.lockPath), false);
});

test('server lock acquisition never replaces an unverifiable owner', () => {
  const root = mkdtempForTestSync('agent-device-daemon-server-lock-');
  const lockPath = path.join(root, 'daemon.lock');
  fs.writeFileSync(lockPath, JSON.stringify(existingLock));
  const replacement = { ...existingLock, pid: 42, processStartTime: 'replacement-start' };

  assert.equal(
    acquireDaemonLock(root, lockPath, replacement, () => 'unknown'),
    false,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), existingLock);
});

test('server lock acquisition replaces only a proven stale owner', () => {
  const root = mkdtempForTestSync('agent-device-daemon-server-stale-lock-');
  const lockPath = path.join(root, 'daemon.lock');
  fs.writeFileSync(lockPath, JSON.stringify(existingLock));
  const replacement = { ...existingLock, pid: 42, processStartTime: 'replacement-start' };

  assert.equal(
    acquireDaemonLock(root, lockPath, replacement, () => 'different'),
    true,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), replacement);
});

test('malformed daemon locks fail closed on both client and server paths', () => {
  const paths = daemonPathsWithLock('{malformed');
  const replacement = { ...existingLock, pid: 42, processStartTime: 'replacement-start' };

  assert.equal(
    cleanupStaleDaemonLockIfSafe(paths, () => 'absent'),
    false,
  );
  assert.equal(
    acquireDaemonLock(paths.baseDir, paths.lockPath, replacement, () => 'absent'),
    false,
  );
  assert.equal(fs.readFileSync(paths.lockPath, 'utf8'), '{malformed');
});

test('failed-start and lock-recovery paths retain malformed lock authority', async () => {
  const paths = daemonPathsWithLock('{malformed');

  const cleanup = await cleanupFailedDaemonStartupMetadata(paths, 'start_error');
  assert.equal(cleanup.removedLock, false);
  assert.equal(cleanup.retainedLockProcess, true);
  assert.match(cleanup.error ?? '', /malformed/);
  assert.equal(await recoverDaemonLockHolder(paths), false);
  assert.equal(fs.readFileSync(paths.lockPath, 'utf8'), '{malformed');
});

test('one mutation guard serializes client cleanup and server publication', () => {
  const paths = daemonPathsWithLock(existingLock);
  const replacement = { ...existingLock, pid: 42, processStartTime: 'replacement-start' };
  let concurrentAcquire: boolean | undefined;

  assert.equal(
    cleanupStaleDaemonLockIfSafe(paths, () => {
      concurrentAcquire = acquireDaemonLock(
        paths.baseDir,
        paths.lockPath,
        replacement,
        () => 'different',
      );
      return 'absent';
    }),
    true,
  );
  assert.equal(concurrentAcquire, false);
  assert.equal(acquireDaemonLock(paths.baseDir, paths.lockPath, replacement), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.lockPath, 'utf8')), replacement);
});

test('an unreleased mutation guard fails closed without touching the daemon lock', () => {
  const paths = daemonPathsWithLock(existingLock);
  const release = tryAcquireDaemonLockMutationGuard(paths.lockPath);
  assert.ok(release);
  try {
    assert.equal(
      cleanupStaleDaemonLockIfSafe(paths, () => 'absent'),
      false,
    );
    assert.equal(
      acquireDaemonLock(
        paths.baseDir,
        paths.lockPath,
        { ...existingLock, pid: 42 },
        () => 'different',
      ),
      false,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.lockPath, 'utf8')), existingLock);
  } finally {
    release();
  }
});

test('failed-start cleanup treats a mutation guard as live authority before lock publication', async () => {
  const root = mkdtempForTestSync('agent-device-daemon-guard-before-lock-');
  const paths = resolveDaemonPaths(root);
  const release = tryAcquireDaemonLockMutationGuard(paths.lockPath);
  assert.ok(release);
  try {
    const cleanup = await cleanupFailedDaemonStartupMetadata(paths, 'start_error');
    assert.equal(cleanup.retainedLockProcess, true);
    assert.match(cleanup.error ?? '', /owned by another process/);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    release();
  }
});

test('guard-only refusal exposes conservative manual recovery for the exact guard', () => {
  const root = mkdtempForTestSync('agent-device-daemon-guard-recovery-');
  const paths = resolveDaemonPaths(root);
  const guardPath = resolveDaemonLockMutationGuardPath(paths.lockPath);
  const release = tryAcquireDaemonLockMutationGuard(paths.lockPath);
  assert.ok(release);
  try {
    assert.equal(cleanupStaleDaemonLockIfSafe(paths), false);
    const hint = resolveDaemonStartupHint({ hasInfo: false, hasLock: false }, paths);
    assert.match(hint, /Only after confirming that no agent-device client or daemon/);
    assert.ok(hint.includes(`rmdir '${guardPath}'`));
    assert.equal(fs.existsSync(guardPath), true);
  } finally {
    release();
  }
});

function daemonPathsWithLock(contents: DaemonLockInfo | string) {
  const root = mkdtempForTestSync('agent-device-daemon-client-lock-');
  const paths = resolveDaemonPaths(root);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.lockPath,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
  return paths;
}
