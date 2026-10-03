import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';

type FileIdentity = Readonly<{
  device: number;
  inode: number;
  mode: number;
}>;

export type PreparedProductsRoot = Readonly<{
  path: string;
  identity: FileIdentity;
}>;

export type PreparedPathSnapshot = Readonly<{
  resolvedPath: string;
  components: readonly Readonly<{ path: string; identity: FileIdentity }>[];
}>;

export function openPreparedProductsRoot(value: string): PreparedProductsRoot {
  const resolved = path.resolve(value);
  const stat = readPathStat(resolved, 'Products root does not exist');
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw storageError('runner_preparation_root_invalid', 'Products root must be a real directory');
  }
  return Object.freeze({ path: resolved, identity: identityOf(stat) });
}

export function capturePreparedPath(
  root: PreparedProductsRoot,
  relativePath: string,
  requireFile: boolean,
): PreparedPathSnapshot {
  assertPreparedRootUnchanged(root);
  const resolvedPath = path.resolve(root.path, relativePath);
  if (!resolvedPath.startsWith(`${root.path}${path.sep}`)) {
    throw storageError('runner_preparation_path_invalid', 'XCTest runner path escapes Products');
  }
  const components = [{ path: root.path, identity: root.identity }];
  let current = root.path;
  for (const component of relativePath.split(path.sep)) {
    current = path.join(current, component);
    const stat = readPathStat(current, 'XCTest runner path is missing');
    if (stat.isSymbolicLink()) {
      throw storageError(
        'runner_preparation_path_invalid',
        'XCTest runner path must not contain symbolic links',
      );
    }
    components.push({ path: current, identity: identityOf(stat) });
  }
  const finalStat = readPathStat(resolvedPath, 'XCTest runner path is missing');
  if (requireFile && !finalStat.isFile()) {
    throw storageError('runner_preparation_path_invalid', 'XCTest runner base must be a file');
  }
  return Object.freeze({ resolvedPath, components: Object.freeze(components) });
}

export function readPreparedFile(snapshot: PreparedPathSnapshot): Buffer {
  assertPreparedPathUnchanged(snapshot);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      snapshot.resolvedPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    const expected = snapshot.components.at(-1)?.identity;
    if (!opened.isFile() || !expected || !sameIdentity(identityOf(opened), expected)) {
      throw storageChanged('Opened XCTest runner base identity changed');
    }
    const bytes = fs.readFileSync(descriptor);
    assertPreparedPathUnchanged(snapshot);
    return bytes;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw storageError(
      'runner_preparation_path_invalid',
      'Failed to open XCTest runner base without following links',
      error,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function assertPreparedPathUnchanged(snapshot: PreparedPathSnapshot): void {
  for (const component of snapshot.components) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(component.path);
    } catch (error) {
      throw storageChanged('Prepared runner input disappeared', error);
    }
    if (stat.isSymbolicLink() || !sameIdentity(identityOf(stat), component.identity)) {
      throw storageChanged('Prepared runner input identity changed');
    }
  }
}

export function assertPreparedRootUnchanged(root: PreparedProductsRoot): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root.path);
  } catch (error) {
    throw storageChanged('Products root disappeared', error);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !sameIdentity(identityOf(stat), root.identity)
  ) {
    throw storageChanged('Products root identity changed');
  }
}

function readPathStat(filePath: string, message: string): fs.Stats {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    throw storageError('runner_preparation_path_invalid', message, error);
  }
}

function identityOf(stat: fs.Stats): FileIdentity {
  return Object.freeze({ device: stat.dev, inode: stat.ino, mode: stat.mode });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
}

function storageChanged(message: string, cause?: unknown): AppError {
  return storageError('runner_preparation_path_changed', message, cause);
}

function storageError(reason: string, message: string, cause?: unknown): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason,
    ...(cause === undefined ? {} : { cause: String(cause) }),
  });
}
