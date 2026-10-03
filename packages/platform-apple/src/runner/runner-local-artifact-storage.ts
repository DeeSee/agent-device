import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppleRunnerArtifactBuildError } from './runner-local-artifact-contract.ts';

export type RunnerArtifactTreeEntry = Readonly<{
  kind: 'directory' | 'file';
  path: string;
  mode: number;
  size?: number;
  sha256?: string;
}>;

export type RunnerArtifactTreeSnapshot = Readonly<{
  entries: readonly RunnerArtifactTreeEntry[];
  sha256: string;
  fileCount: number;
  byteCount: number;
}>;

export function snapshotRunnerArtifactTree(
  root: string,
  role: 'source' | 'product',
): RunnerArtifactTreeSnapshot {
  assertDirectory(root, role);
  const entries: RunnerArtifactTreeEntry[] = [];
  visitTree(root, '', role, entries);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const files = entries.filter((entry) => entry.kind === 'file');
  return Object.freeze({
    entries: Object.freeze(entries),
    sha256: sha256(Buffer.from(JSON.stringify(entries))),
    fileCount: files.length,
    byteCount: files.reduce((total, entry) => total + (entry.size ?? 0), 0),
  });
}

export function frozenRunnerArtifactTreeSha256(root: string): string {
  const entries = snapshotRunnerArtifactTree(root, 'source')
    .entries.filter((entry) => entry.kind === 'file')
    .map((entry) => ({ ...entry, mode: frozenRunnerArtifactEntryMode(entry, 'immutable') }));
  return sha256(Buffer.from(JSON.stringify(entries)));
}

export function copyRunnerArtifactTree(
  source: string,
  destination: string,
  role: 'source' | 'product' = 'product',
): void {
  if (fs.existsSync(destination)) {
    throw failure('publication_conflict', 'Runner artifact copy destination already exists');
  }
  const before = snapshotRunnerArtifactTree(source, role);
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  copyDirectoryContents(source, destination, role);
  const after = snapshotRunnerArtifactTree(source, role);
  const copied = snapshotRunnerArtifactTree(destination, role);
  if (before.sha256 !== after.sha256 || before.sha256 !== copied.sha256) {
    throw failure('product_copy_changed', 'Runner product tree changed while it was copied');
  }
}

/**
 * `immutable` also strips directory write bits so nothing can be added to the tree while it is
 * in use — the frozen runner source, which xcodebuild must not be able to extend.
 * `installable` keeps directory modes: CoreSimulator installs a bundle with copyfile, which
 * recreates every destination directory with the source directory's mode and then writes its
 * children into it, so a read-only directory fails the install with EACCES. Files carry the
 * tree's content and stay read-only under both.
 */
export type RunnerArtifactFreeze = 'immutable' | 'installable';

export function freezeRunnerArtifactTree(root: string, freeze: RunnerArtifactFreeze): void {
  const entries = snapshotRunnerArtifactTree(root, 'product');
  for (const entry of [...entries.entries].reverse()) {
    fs.chmodSync(path.join(root, entry.path), frozenRunnerArtifactEntryMode(entry, freeze));
  }
  if (freeze === 'immutable') fs.chmodSync(root, fs.statSync(root).mode & ~0o222);
}

export function frozenRunnerArtifactEntryMode(
  entry: Pick<RunnerArtifactTreeEntry, 'kind' | 'mode'>,
  freeze: RunnerArtifactFreeze,
): number {
  return freeze === 'installable' && entry.kind === 'directory' ? entry.mode : entry.mode & ~0o222;
}

export function writeDurableRunnerArtifactFile(filePath: string, bytes: Uint8Array | string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o444,
    );
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function makeRunnerArtifactTreeRemovable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) makeRunnerArtifactTreeRemovable(path.join(root, entry.name));
  }
}

export function sha256(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function visitTree(
  root: string,
  relativeDirectory: string,
  role: 'source' | 'product',
  output: RunnerArtifactTreeEntry[],
): void {
  const directory = path.join(root, relativeDirectory);
  for (const name of fs.readdirSync(directory).sort()) {
    if (role === 'source' && isGeneratedSourceEntry(name)) continue;
    const relativePath = path.join(relativeDirectory, name);
    const absolutePath = path.join(root, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw roleFailure(role, 'symlink', relativePath);
    }
    if (stat.isDirectory()) {
      output.push({ kind: 'directory', path: relativePath, mode: stat.mode & 0o777 });
      visitTree(root, relativePath, role, output);
      assertSameOpenedIdentity(stat, fs.lstatSync(absolutePath), role, relativePath);
      continue;
    }
    if (!stat.isFile()) {
      throw roleFailure(role, 'special_file', relativePath);
    }
    if (stat.nlink !== 1) {
      throw roleFailure(role, 'hardlink', relativePath);
    }
    const bytes = readRegularFileNoFollow(absolutePath, stat, role, relativePath);
    output.push({
      kind: 'file',
      path: relativePath,
      mode: stat.mode & 0o777,
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }
}

function copyDirectoryContents(
  source: string,
  destination: string,
  role: 'source' | 'product',
): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (role === 'source' && isGeneratedSourceEntry(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw roleFailure(role, 'symlink', entry.name);
    if (stat.isDirectory()) {
      fs.mkdirSync(destinationPath, { mode: 0o700 });
      copyDirectoryContents(sourcePath, destinationPath, role);
      fs.chmodSync(destinationPath, stat.mode & 0o777);
      continue;
    }
    if (!stat.isFile()) throw roleFailure(role, 'special_file', entry.name);
    if (stat.nlink !== 1) throw roleFailure(role, 'hardlink', entry.name);
    const bytes = readRegularFileNoFollow(sourcePath, stat, role, entry.name);
    let destinationDescriptor: number | undefined;
    try {
      destinationDescriptor = fs.openSync(
        destinationPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        stat.mode & 0o777,
      );
      fs.writeFileSync(destinationDescriptor, bytes);
      fs.fsyncSync(destinationDescriptor);
    } finally {
      if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    }
    fs.chmodSync(destinationPath, stat.mode & 0o777);
    if (fs.lstatSync(destinationPath).nlink !== 1) {
      throw roleFailure(role, 'hardlink', entry.name);
    }
  }
}

function readRegularFileNoFollow(
  filePath: string,
  expected: fs.Stats,
  role: 'source' | 'product',
  relativePath: string,
): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw roleFailure(role, 'special_file', relativePath);
    if (before.nlink !== 1) throw roleFailure(role, 'hardlink', relativePath);
    assertSameOpenedIdentity(expected, before, role, relativePath);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw failure('product_copy_changed', `Runner file changed while read: ${relativePath}`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertSameOpenedIdentity(
  expected: fs.Stats,
  actual: fs.Stats,
  role: 'source' | 'product',
  relativePath: string,
): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.mode !== actual.mode ||
    expected.size !== actual.size ||
    expected.mtimeMs !== actual.mtimeMs
  ) {
    throw failure(
      role === 'source' ? 'source_invalid' : 'product_copy_changed',
      `${role} path identity changed while opened: ${relativePath}`,
    );
  }
}

function assertDirectory(root: string, role: 'source' | 'product'): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    throw failure(
      role === 'source' ? 'source_invalid' : 'xctestrun_invalid',
      `Missing ${role} tree`,
      error,
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw failure(
      role === 'source' ? 'source_invalid' : 'xctestrun_invalid',
      `Unsafe ${role} tree`,
    );
  }
}

function roleFailure(
  role: 'source' | 'product',
  kind: 'symlink' | 'hardlink' | 'special_file',
  relativePath: string,
): AppleRunnerArtifactBuildError {
  const code = role === 'source' ? 'source_invalid' : (`product_${kind}_refused` as const);
  return failure(code, `${role} tree contains a refused ${kind}: ${relativePath}`);
}

function failure(
  code: AppleRunnerArtifactBuildError['code'],
  message: string,
  cause?: unknown,
): AppleRunnerArtifactBuildError {
  return new AppleRunnerArtifactBuildError(code, message, cause);
}

function isGeneratedSourceEntry(name: string): boolean {
  return (
    name === '.build' ||
    name === '.swiftpm' ||
    name === 'xcuserdata' ||
    name === '.DS_Store' ||
    name.endsWith('.xcuserstate')
  );
}

export function snapshotRunnerProducerFiles(root: string, labels: readonly string[]): string {
  const entries = [...labels].sort().map((label) => {
    const pathname = path.isAbsolute(label) ? label : path.join(root, label);
    const stat = fs.lstatSync(pathname);
    const bytes = readRegularFileNoFollow(pathname, stat, 'source', label);
    return { path: label, mode: stat.mode & 0o777, sha256: sha256(bytes) };
  });
  return sha256(Buffer.from(JSON.stringify(entries)));
}
