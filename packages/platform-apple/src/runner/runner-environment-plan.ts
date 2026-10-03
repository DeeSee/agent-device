import { buildRunnerSessionXctestrunSuffix } from './runner-artifact-env.ts';
import { AppError } from '@agent-device/kernel/errors';

const MAX_PORT_ALLOCATION_ATTEMPTS = 8;

type RunnerEnvironmentArtifact = Readonly<{
  xctestrunPath: string;
  jsonPath: string;
}>;

export type RunnerEnvironmentPlan = Readonly<{
  port: number;
  xctestrunPath: string;
  ownedEnvironmentFiles: readonly string[];
}>;

export async function prepareRunnerEnvironment(input: {
  baseXctestrunPath: string;
  deviceId: string;
  ownerToken: string;
  iosXctestEnvDir?: string;
  excludedPort?: number;
  allocatePort: () => Promise<number>;
  prepareOverlay: (
    xctestrunPath: string,
    env: Record<string, string>,
    suffix: string,
    options: { iosXctestEnvDir?: string },
  ) => Promise<RunnerEnvironmentArtifact>;
}): Promise<RunnerEnvironmentPlan> {
  let port: number | undefined;
  for (let attempt = 0; attempt < MAX_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidate = await input.allocatePort();
    if (candidate !== input.excludedPort) {
      port = candidate;
      break;
    }
  }
  if (port === undefined) {
    throw new AppError('COMMAND_FAILED', 'Failed to allocate a different runner port', {
      reason: 'runner_port_allocation_exhausted',
    });
  }
  const overlay = await input.prepareOverlay(
    input.baseXctestrunPath,
    { AGENT_DEVICE_RUNNER_PORT: String(port) },
    buildRunnerSessionXctestrunSuffix({
      deviceId: input.deviceId,
      ownerToken: input.ownerToken,
      port,
    }),
    { iosXctestEnvDir: input.iosXctestEnvDir },
  );
  return Object.freeze({
    port,
    xctestrunPath: overlay.xctestrunPath,
    ownedEnvironmentFiles: Object.freeze([overlay.xctestrunPath, overlay.jsonPath]),
  });
}
