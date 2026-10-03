import fs from 'node:fs';
import path from 'node:path';

const DAEMON_LOCK_MUTATION_GUARD_SUFFIX = '.mutation-guard';

export function resolveDaemonLockMutationGuardPath(lockPath: string): string {
  return `${lockPath}${DAEMON_LOCK_MUTATION_GUARD_SUFFIX}`;
}

// Serializes every cooperating daemon.lock inspect/remove/publish sequence. The guard is
// deliberately fail-closed: it is never reclaimed automatically, because guessing that a guard
// is stale would recreate the same ABA window this authority is meant to prevent. A process that
// crashes in this short critical section leaves explicit metadata for manual recovery rather than
// permitting two daemon writers.
export function tryAcquireDaemonLockMutationGuard(lockPath: string): (() => void) | null {
  const guardPath = resolveDaemonLockMutationGuardPath(lockPath);
  fs.mkdirSync(path.dirname(guardPath), { recursive: true });
  try {
    fs.mkdirSync(guardPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      fs.rmdirSync(guardPath);
    } catch {
      // A missing or externally modified guard is not safe to repair automatically.
    }
  };
}
