import {
  readAgentDeviceArtifactVersion,
  loadedAgentDevicePackageRoot,
} from './runner-package-root.ts';
import {
  captureRunnerBuildSources,
  frozenRunnerBuildSourcesSha256,
} from './runner-local-artifact-source-set.ts';
declare const __AGENT_DEVICE_VERSION__: string;
declare const __AGENT_DEVICE_RUNNER_SOURCE_SHA256__: string;
export function loadedAgentDeviceVersion(): string {
  if (typeof __AGENT_DEVICE_VERSION__ === 'string') return __AGENT_DEVICE_VERSION__;
  // Unit tests execute source directly, outside the tsdown define.
  return readAgentDeviceArtifactVersion(loadedAgentDevicePackageRoot(import.meta.url));
}

/** @internal Shared by the local artifact materializer. */
export function loadedAgentDeviceRunnerSourceSha256(): string {
  if (typeof __AGENT_DEVICE_RUNNER_SOURCE_SHA256__ === 'string') {
    return __AGENT_DEVICE_RUNNER_SOURCE_SHA256__;
  }
  return frozenRunnerBuildSourcesSha256(
    captureRunnerBuildSources(loadedAgentDevicePackageRoot(import.meta.url)),
  );
}
