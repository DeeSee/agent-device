import fs from 'node:fs';
import path from 'node:path';
import { AppleRunnerArtifactBuildError } from './runner-local-artifact-contract.ts';
import {
  makeRunnerArtifactTreeRemovable,
  snapshotRunnerArtifactTree,
  writeDurableRunnerArtifactFile,
} from './runner-local-artifact-storage.ts';

/**
 * Publishes an explicitly untrusted local candidate. The distributor performs
 * the descriptor-safe snapshot, attestation, signing, and durable publication.
 */
export function publishLocalRunnerCandidate(input: {
  outputParent: string;
  variant: 'device' | 'simulator';
  stageRoot: string;
  manifestBytes: Buffer;
  manifestSha256: string;
  productsRoot: string;
  expectedProductsSha256: string;
}): string {
  writeDurableRunnerArtifactFile(path.join(input.stageRoot, 'manifest.json'), input.manifestBytes);
  if (
    snapshotRunnerArtifactTree(input.productsRoot, 'product').sha256 !==
    input.expectedProductsSha256
  ) {
    throw new AppleRunnerArtifactBuildError(
      'product_copy_changed',
      'The staged product tree changed immediately before local candidate publication',
    );
  }
  const nonce = path
    .basename(path.dirname(input.stageRoot))
    .replace(/^\.agent-device-runner-build-/u, '');
  const artifactRoot = path.join(
    input.outputParent,
    `agent-device-ios-${input.variant}-runner-${input.manifestSha256}-${nonce}`,
  );
  if (fs.existsSync(artifactRoot)) {
    throw new AppleRunnerArtifactBuildError(
      'publication_conflict',
      'Local runner candidate destination already exists',
    );
  }
  try {
    // This rename is the final candidate-publication effect. There is no trust,
    // durability, immutability, or activation marker in a local candidate.
    fs.renameSync(input.stageRoot, artifactRoot);
  } catch (error) {
    throw new AppleRunnerArtifactBuildError(
      'publication_unresolved',
      `Local runner candidate publication is unresolved at ${artifactRoot}`,
      error,
    );
  }
  return artifactRoot;
}

export function settleLocalRunnerWorkRoot(workRoot: string): boolean {
  try {
    makeRunnerArtifactTreeRemovable(workRoot);
    fs.rmSync(workRoot, { force: true, recursive: true });
    return !fs.existsSync(workRoot);
  } catch {
    // This is best-effort cleanup of a private local work directory, never an
    // exact-owned security operation and never part of candidate validity.
    return false;
  }
}
