import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const lifecycleEvents = vi.hoisted(() => [] as string[]);
const startupReconciliation = vi.hoisted(() => ({
  run: async (..._args: unknown[]) => ({ examined: 0, reconciled: 0, retained: 0, changed: 0 }),
}));

vi.mock('../../platform-runtime.ts', () => ({
  androidObservation: {},
  createRequestPlatformProviders: () => ({
    run: async (_context: unknown, task: () => Promise<unknown>) => await task(),
  }),
  createPlatformRuntimeGateway: () => ({
    applicationLifecycle: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => {
        lifecycleEvents.push('detach');
        // The real diagnostics module, unmocked: what this records is whether a diagnostic raised by
        // the handoff reaches disk at all, which only the shutdown's own scope can decide (#2681).
        const { emitDiagnostic } = await import('@agent-device/host-kit/diagnostics');
        emitDiagnostic({
          level: 'debug',
          phase: 'detach_scope_probe',
          data: { lane: 'physical_coredevice' },
        });
      },
      finalizeDaemonShutdown: async () => {
        lifecycleEvents.push('finalize');
      },
    },
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind: async () => {
      throw new Error('unused');
    },
    shutdown: async () => {
      lifecycleEvents.push('gateway-shutdown');
    },
  }),
  createPlatformDeviceInventoryGateways: () => ({}),
}));

vi.mock('../../provider-device-runtimes.ts', () => ({
  DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS: [],
  createDefaultProviderRuntimeComposition: async () => ({ runtimes: [], platformModules: [] }),
}));

vi.mock('../device/device-claims.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../device/device-claims.ts')>();
  return {
    ...original,
    reconcileOrphanedDeviceClaims: (...args: unknown[]) => startupReconciliation.run(...args),
  };
});

import { startDaemonRuntime } from './daemon-runtime.ts';

afterEach(() => {
  lifecycleEvents.length = 0;
  startupReconciliation.run = async () => ({
    examined: 0,
    reconciled: 0,
    retained: 0,
    changed: 0,
  });
  vi.restoreAllMocks();
});

test('defers a published-daemon signal until startup reconciliation settles', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-signal-readiness-');
  let sigterm: (() => void) | undefined;
  let releaseReconciliation: (() => void) | undefined;
  let reconciliationStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    reconciliationStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseReconciliation = resolve;
  });
  const exits: number[] = [];
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  startupReconciliation.run = async () => {
    lifecycleEvents.push('reconcile-start');
    reconciliationStarted?.();
    await held;
    lifecycleEvents.push('reconcile-end');
    return { examined: 0, reconciled: 0, retained: 0, changed: 0 };
  };
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGTERM') sigterm = listener as () => void;
    return process;
  });

  try {
    const runtime = startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      exit: (code) => {
        exits.push(code);
        resolveExit?.();
      },
      stderr: { write: () => {} },
      stdout: {
        write: () => {
          expect(sigterm).toBeDefined();
        },
      },
    });
    await started;
    sigterm?.();
    await Promise.resolve();
    expect(lifecycleEvents).toEqual(['reconcile-start']);

    releaseReconciliation?.();
    expect(await runtime).not.toBeNull();
    await exited;
    expect(lifecycleEvents).toEqual([
      'reconcile-start',
      'reconcile-end',
      'detach',
      'gateway-shutdown',
      'finalize',
    ]);
    expect(exits).toEqual([0]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon shutdown detaches before session teardown and force-finalizes only after gateway resources', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-lifecycle-shutdown-');
  const exits: number[] = [];
  const startupErrors: string[] = [];
  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      exit: (code) => exits.push(code),
      registerProcessHandlers: false,
      stderr: { write: (chunk) => startupErrors.push(chunk) },
      stdout: { write: () => {} },
    });
    expect(runtime, startupErrors.join('')).not.toBeNull();

    await Promise.all([runtime?.shutdown(), runtime?.shutdown()]);

    expect(lifecycleEvents).toEqual(['detach', 'gateway-shutdown', 'finalize']);
    expect(exits).toEqual([0]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a SIGTERM shutdown gives the handoff a diagnostics scope to write its reasons into', async () => {
  // Without the scope, `emitDiagnostic` is a no-op outside a request and every detach reason —
  // including "why did this runner get killed instead of handed off" — disappears with the daemon.
  const stateDir = mkdtempForTestSync('agent-device-daemon-detach-diagnostics-');
  try {
    const runtime = await startDaemonRuntime({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
      exit: () => {},
      registerProcessHandlers: false,
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    });
    expect(runtime).not.toBeNull();

    await runtime?.shutdown();

    const daemonLog = fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8');
    expect(daemonLog).toMatch(/"phase":"detach_scope_probe"/);
    expect(daemonLog).toMatch(/"lane":"physical_coredevice"/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
