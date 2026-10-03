import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { openVerifiedFileForRead } from '@agent-device/host-kit/file';

const SCREENSHOT_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Gives the ordinary local screenshot command one client-owned private output
 * path, consumes bounded bytes, and removes the complete namespace.
 */
export async function captureLocalScreenshotArtifact<T>(
  capture: (outputPath: string) => Promise<T>,
): Promise<Readonly<{ result: T; bytes: Uint8Array }>> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agent-device-screenshot-'));
  const outputPath = path.join(root, 'screenshot.png');
  try {
    const result = await capture(outputPath);
    return Object.freeze({
      result,
      bytes: await readBoundedScreenshot(outputPath),
    });
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
}

async function readBoundedScreenshot(filePath: string): Promise<Uint8Array> {
  let descriptor: number | undefined;
  try {
    descriptor = openVerifiedFileForRead(filePath);
  } catch {
    return refuse('read_failed');
  }
  if (descriptor === undefined) return refuse('file_missing');
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assertReadableScreenshot(before);
    const bytes = readScreenshotBytes(descriptor, Number(before.size));
    assertScreenshotUnchanged(descriptor, before);
    return new Uint8Array(bytes);
  } catch (error) {
    if (error instanceof AppError) throw error;
    return refuse('read_failed');
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertReadableScreenshot(stat: fs.BigIntStats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.size < 1n ||
    stat.size > BigInt(SCREENSHOT_ARTIFACT_MAX_BYTES)
  )
    refuse('file_invalid');
}

function readScreenshotBytes(descriptor: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) refuse('artifact_changed');
    offset += count;
  }
  return bytes;
}

function assertScreenshotUnchanged(descriptor: number, before: fs.BigIntStats): void {
  const probe = Buffer.allocUnsafe(1);
  const after = fs.fstatSync(descriptor, { bigint: true });
  const identityKeys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const;
  if (
    fs.readSync(descriptor, probe, 0, 1, Number(before.size)) !== 0 ||
    identityKeys.some((key) => before[key] !== after[key])
  )
    refuse('artifact_changed');
}

function refuse(reason: string): never {
  throw new AppError('COMMAND_FAILED', 'Local screenshot artifact could not be consumed safely.', {
    reason,
  });
}
