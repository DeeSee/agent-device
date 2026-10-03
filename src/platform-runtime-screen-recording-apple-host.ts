import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function createAppleScreenRecordingHost(): ScreenRecordingRuntimeHost['apple'] {
  return Object.freeze({
    availability: appleScreenRecordingAvailability,
    runRunner: async (device, request, signal) => {
      const { runAppleRecordingRunner } =
        await import('./platform-runtime-screen-recording-apple-runner-host.ts');
      return await runAppleRecordingRunner(device, request, signal);
    },
    startSimulator: async (device, outputPath, signal) => {
      const { startAppleSimulatorRecording } =
        await import('./platform-runtime-screen-recording-apple-simulator-host.ts');
      return await startAppleSimulatorRecording(device, outputPath, signal);
    },
    inspectProcess: async (marker) => {
      const { inspectAppleSimulatorRecordingProcess } =
        await import('./platform-runtime-screen-recording-apple-simulator-host.ts');
      return inspectAppleSimulatorRecordingProcess(marker);
    },
    terminateProcess: async (marker) => {
      const { terminateAppleSimulatorRecordingProcess } =
        await import('./platform-runtime-screen-recording-apple-simulator-host.ts');
      return await terminateAppleSimulatorRecordingProcess(marker);
    },
    inspectRunner: async (device, recordingAuthority, runnerAuthority) => {
      const { inspectAppleRunnerOwnership } =
        await import('./platform-runtime-screen-recording-apple-runner-host.ts');
      return await inspectAppleRunnerOwnership(device, recordingAuthority, runnerAuthority);
    },
    retrieveRunnerRecording: async (
      device,
      runnerAuthority,
      recordingAuthority,
      outputPath,
      signal,
    ) => {
      const { retrieveAppleRunnerRecording } =
        await import('./platform-runtime-screen-recording-apple-runner-host.ts');
      await retrieveAppleRunnerRecording(
        device,
        runnerAuthority,
        recordingAuthority,
        outputPath,
        signal,
      );
    },
    captureClockAnchor: async (device, appBundleId, signal) => {
      const { captureAppleClockAnchor } =
        await import('./platform-runtime-screen-recording-apple-runner-host.ts');
      return await captureAppleClockAnchor(device, appBundleId, signal);
    },
    isRunnerBundleId: async (device, bundleId) => {
      const { isAppleRunnerBundleId } =
        await import('./platform-runtime-screen-recording-apple-runner-host.ts');
      return await isAppleRunnerBundleId(device, bundleId);
    },
  });
}

async function appleScreenRecordingAvailability(device: DeviceInfo) {
  if (device.kind === 'simulator') {
    const { resolveAppleSimulatorScreenRecordingTransport } =
      await import('./platform-runtime-screen-recording-apple-transport.ts');
    return resolveAppleSimulatorScreenRecordingTransport().available
      ? ({ available: true } as const)
      : ({
          available: false,
          hint: 'Configure a focused Apple simulator recording transport for this provider.',
        } as const);
  }
  const { resolveAppleRunnerScreenRecordingTransport } =
    await import('./platform-runtime-screen-recording-apple-runner-transport.ts');
  return resolveAppleRunnerScreenRecordingTransport().available
    ? ({ available: true } as const)
    : ({
        available: false,
        hint: 'This scoped Apple runner provider does not expose durable recording authority.',
      } as const);
}
