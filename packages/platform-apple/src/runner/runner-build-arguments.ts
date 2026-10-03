export type RunnerBuildForTestingArguments = Readonly<{
  projectPath: string;
  destinationArgs: readonly string[];
  derivedDataPath: string;
  maximumConcurrentDestinationsFlag:
    | '-maximum-concurrent-test-device-destinations'
    | '-maximum-concurrent-test-simulator-destinations';
  buildSettings: readonly string[];
}>;

/** Single argv projection for every AgentDeviceRunner build-for-testing call. */
export function createRunnerBuildForTestingArguments(
  input: RunnerBuildForTestingArguments,
): string[] {
  return [
    'build-for-testing',
    '-project',
    input.projectPath,
    '-scheme',
    'AgentDeviceRunner',
    '-parallel-testing-enabled',
    'NO',
    input.maximumConcurrentDestinationsFlag,
    '1',
    ...input.destinationArgs,
    '-derivedDataPath',
    input.derivedDataPath,
    ...input.buildSettings,
  ];
}
