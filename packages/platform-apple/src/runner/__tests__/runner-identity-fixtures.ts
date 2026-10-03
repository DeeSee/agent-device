import type { RunnerLaunchIdentity, RunnerLaunchSelection } from '../runner-launch-identity.ts';

export const RUNNER_LAUNCH_IDENTITY_FIXTURE: RunnerLaunchIdentity = Object.freeze({
  selectorFingerprint: 'fixture',
  testHostContainerBundleId: 'com.callstack.agentdevice.runner.uitests.xctrunner',
});

export function makeRunnerLaunchSelection(
  overrides: Partial<RunnerLaunchSelection> = {},
): RunnerLaunchSelection {
  return {
    source: 'internal',
    identity: RUNNER_LAUNCH_IDENTITY_FIXTURE,
    derived: '/tmp/derived',
    ...overrides,
  };
}
