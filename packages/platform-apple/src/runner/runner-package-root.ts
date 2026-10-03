import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppleRunnerArtifactBuildError } from './runner-local-artifact-contract.ts';

export function loadedAgentDevicePackageRoot(moduleUrl: string): string {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      const identity = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown };
      if (identity.name === 'agent-device') return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new AppleRunnerArtifactBuildError(
        'source_invalid',
        'Unable to locate the loaded agent-device package',
      );
    }
    directory = parent;
  }
}

export function readAgentDeviceArtifactVersion(sourceRoot: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (parsed.name !== 'agent-device' || typeof parsed.version !== 'string' || !parsed.version) {
      throw new Error('invalid package identity');
    }
    return parsed.version;
  } catch (error) {
    throw new AppleRunnerArtifactBuildError(
      'source_invalid',
      'Invalid agent-device package identity',
      error,
    );
  }
}
