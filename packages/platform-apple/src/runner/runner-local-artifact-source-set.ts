import { loadedAgentDevicePackageRoot } from './runner-package-root.ts';
import { walkProducerCodeGraph } from './host.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppleRunnerArtifactBuildError } from './runner-local-artifact-contract.ts';
import {
  copyRunnerArtifactTree,
  freezeRunnerArtifactTree,
  frozenRunnerArtifactTreeSha256,
  sha256,
  snapshotRunnerArtifactTree,
  snapshotRunnerProducerFiles,
  type RunnerArtifactTreeSnapshot,
} from './runner-local-artifact-storage.ts';

// The Xcode project references the local Swift package at ../../snapshot-presentation.
// Both trees are one build input, including the package manifest that selects its targets.
const RUNNER_SOURCE_PATHS = [
  'apple/runner/AgentDeviceRunner',
  'apple/snapshot-presentation',
] as const;

export type RunnerSourceSet = Readonly<{
  root: string;
  trees: readonly Readonly<{ relativePath: string; snapshot: RunnerArtifactTreeSnapshot }>[];
  sha256: string;
}>;

export function captureRunnerBuildSources(root: string): RunnerSourceSet {
  return captureSourceSet(root, RUNNER_SOURCE_PATHS);
}

export type RunnerProducerSource = Readonly<{ moduleUrl: string; sha256: string }>;

export async function captureLoadedProducerSources(
  moduleUrl: string,
): Promise<RunnerProducerSource> {
  const root = loadedAgentDevicePackageRoot(moduleUrl);
  const graph = await walkProducerCodeGraph(fileURLToPath(moduleUrl), root);
  return Object.freeze({
    moduleUrl,
    sha256: snapshotRunnerProducerFiles(
      root,
      graph.files.map(([label]) => label),
    ),
  });
}

export async function assertLoadedProducerUnchanged(source: RunnerProducerSource): Promise<void> {
  const current = await captureLoadedProducerSources(source.moduleUrl);
  if (source.sha256 !== current.sha256) {
    throw new AppleRunnerArtifactBuildError(
      'runner_source_changed',
      'The loaded producer module graph changed while the local runner candidate was built',
    );
  }
}

export function freezeRunnerBuildSources(
  source: RunnerSourceSet,
  destination: string,
): RunnerSourceSet {
  for (const tree of source.trees) {
    const target = path.join(destination, tree.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    copyRunnerArtifactTree(path.join(source.root, tree.relativePath), target, 'source');
    freezeRunnerArtifactTree(target, 'immutable');
  }
  return captureSourceSet(
    destination,
    source.trees.map((tree) => tree.relativePath),
  );
}

export function frozenRunnerBuildSourcesSha256(source: RunnerSourceSet): string {
  return sha256(
    Buffer.from(
      JSON.stringify(
        source.trees.map((tree) => ({
          path: tree.relativePath,
          sha256: frozenRunnerArtifactTreeSha256(path.join(source.root, tree.relativePath)),
        })),
      ),
    ),
  );
}

export function assertRunnerSourceSetUnchanged(source: RunnerSourceSet, label: string): void {
  const current = captureSourceSet(
    source.root,
    source.trees.map((tree) => tree.relativePath),
  );
  if (source.sha256 !== current.sha256) {
    throw new AppleRunnerArtifactBuildError(
      'runner_source_changed',
      `The ${label} changed while the local runner candidate was built`,
    );
  }
}

function captureSourceSet(root: string, relativePaths: readonly string[]): RunnerSourceSet {
  const trees = [...relativePaths].sort().map((relativePath) =>
    Object.freeze({
      relativePath,
      snapshot: snapshotRunnerArtifactTree(path.join(root, relativePath), 'source'),
    }),
  );
  return Object.freeze({
    root,
    trees: Object.freeze(trees),
    sha256: sha256(
      Buffer.from(
        JSON.stringify(
          trees.map((tree) => ({ path: tree.relativePath, sha256: tree.snapshot.sha256 })),
        ),
      ),
    ),
  });
}
