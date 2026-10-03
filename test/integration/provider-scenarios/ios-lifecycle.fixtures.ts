import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { FlatToolCall } from './providers.ts';

export function assertStagedAppleInstallCalls(
  calls: readonly FlatToolCall[],
  prefix: readonly string[],
  originalPath: string,
  count: number,
): string[] {
  const installs = calls.filter((call) => prefix.every((arg, index) => call[index] === arg));
  assert.equal(installs.length, count);
  assert.equal(fs.existsSync(originalPath), true, 'the caller owns the original app');
  return installs.map((call) => {
    assert.equal(call.length, prefix.length + 1);
    const stagedPath = call[prefix.length]!;
    assert.notEqual(stagedPath, originalPath);
    assert.equal(path.basename(stagedPath), path.basename(originalPath));
    assert.equal(fs.existsSync(stagedPath), false, 'the staging copy is cleaned after install');
    return stagedPath;
  });
}
