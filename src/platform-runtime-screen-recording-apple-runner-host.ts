import { loadAppleRunnerRecordingOperations } from '@agent-device/platform-apple/runner/recording';
import type {
  AppleRunnerRecordingAuthority,
  AppleScreenRecordingRunnerRequest,
} from '@agent-device/contracts/screen-recording-runtime-host';
import type { ManagedProcessOwnership } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function runAppleRecordingRunner(
  device: DeviceInfo,
  request: AppleScreenRecordingRunnerRequest,
  signal?: AbortSignal,
) {
  const { resolveAppleRunnerScreenRecordingTransport } =
    await import('./platform-runtime-screen-recording-apple-runner-transport.ts');
  const transport = resolveAppleRunnerScreenRecordingTransport();
  if (request.kind === 'release') {
    if (transport.authority !== request.runnerAuthority) {
      throw new Error('Apple runner recording ownership changed before release');
    }
    await transport.release({
      device,
      recordingAuthority: request.recordingAuthority,
      reason: request.reason,
    });
    return {};
  }
  if (request.kind === 'stop') {
    if (transport.authority !== request.runnerAuthority) {
      throw new Error('Apple runner recording ownership changed before cleanup');
    }
    await transport.stop({
      device,
      recordingAuthority: request.recordingAuthority,
      appBundleId: request.appBundleId,
      signal,
    });
    return {};
  }
  const result = await transport.start({
    device,
    appBundleId: request.appBundleId,
    outputPath: request.outputPath,
    fps: request.fps,
    signal,
    iosXctestrunFile: request.iosXctestrunFile,
    iosXctestDerivedDataPath: request.iosXctestDerivedDataPath,
    iosXctestEnvDir: request.iosXctestEnvDir,
  });
  return Object.freeze({
    runnerAuthority: transport.authority,
    recordingAuthority: result.recordingAuthority,
    startState: result.startState,
    ...(typeof result.recorderStartUptimeMs === 'number'
      ? { recorderStartUptimeMs: result.recorderStartUptimeMs }
      : {}),
  });
}

export async function inspectAppleRunnerOwnership(
  device: DeviceInfo,
  recordingAuthority: AppleRunnerRecordingAuthority,
  runnerAuthority: 'local-lease' | 'scoped-provider',
): Promise<ManagedProcessOwnership> {
  const { resolveAppleRunnerScreenRecordingTransport } =
    await import('./platform-runtime-screen-recording-apple-runner-transport.ts');
  const transport = resolveAppleRunnerScreenRecordingTransport();
  return transport.authority === runnerAuthority
    ? await transport.inspect(device, recordingAuthority)
    : 'ownership-lost';
}

export async function retrieveAppleRunnerRecording(
  device: DeviceInfo,
  runnerAuthority: 'local-lease' | 'scoped-provider',
  recordingAuthority: AppleRunnerRecordingAuthority,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const { resolveAppleRunnerScreenRecordingTransport } =
    await import('./platform-runtime-screen-recording-apple-runner-transport.ts');
  const transport = resolveAppleRunnerScreenRecordingTransport();
  if (transport.authority !== runnerAuthority) {
    throw new Error('Apple runner recording ownership changed before retrieval');
  }
  await transport.retrieve({ device, recordingAuthority, outputPath, signal });
}

export async function captureAppleClockAnchor(
  device: DeviceInfo,
  appBundleId: string,
  signal?: AbortSignal,
) {
  try {
    const [simulatorTransport, runnerTransport] = await Promise.all([
      import('./platform-runtime-screen-recording-apple-transport.ts').then((module) =>
        module.resolveAppleSimulatorScreenRecordingTransport(),
      ),
      import('./platform-runtime-screen-recording-apple-runner-transport.ts').then((module) =>
        module.resolveAppleRunnerScreenRecordingTransport(),
      ),
    ]);
    if (
      simulatorTransport.mode === 'transport-composed' &&
      runnerTransport.authority !== 'scoped-provider'
    ) {
      return undefined;
    }
    const { runAppleRunnerCommand } =
      await import('@agent-device/platform-apple/runner/operations');
    const result = await runAppleRunnerCommand(
      device,
      { command: 'snapshot', appBundleId, interactiveOnly: true, depth: 1 },
      { signal },
    );
    const wallClockAtMs = Date.now();
    return typeof result.currentUptimeMs === 'number' &&
      Number.isFinite(result.currentUptimeMs) &&
      result.currentUptimeMs > 0
      ? { wallClockAtMs, uptimeMs: result.currentUptimeMs }
      : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

export async function isAppleRunnerBundleId(
  device: DeviceInfo,
  bundleId: string,
): Promise<boolean> {
  const { getRunnerSessionSnapshot } = await loadAppleRunnerRecordingOperations();
  const session = getRunnerSessionSnapshot(device.id);
  return session?.alive === true && session.launchIdentity.testHostContainerBundleId === bundleId;
}
