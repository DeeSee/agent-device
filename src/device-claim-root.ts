import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';

export type DeviceClaimRoot = Readonly<{
  path: string;
  id: string;
  device: string;
  inode: string;
}>;

export function resolveDeviceClaimRootPath(explicitRoot?: string): string {
  const override = explicitRoot?.trim() || process.env.AGENT_DEVICE_CLAIMS_DIR?.trim();
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), '.agent-device', 'device-claims');
}

export function openDeviceClaimRoot(explicitRoot?: string): DeviceClaimRoot {
  const configuredPath = resolveDeviceClaimRootPath(explicitRoot);
  fs.mkdirSync(configuredPath, { recursive: true, mode: 0o700 });
  const configured = lstatClaimRoot(configuredPath);
  assertPrivateClaimRoot(configured);
  const canonicalPath = fs.realpathSync.native(configuredPath);
  const canonical = lstatClaimRoot(canonicalPath);
  if (!sameFsIdentity(configured, canonical)) throw claimRootRefusal('identity_changed');
  const identity = {
    device: String(canonical.dev),
    inode: String(canonical.ino),
  };
  const root = Object.freeze({
    path: canonicalPath,
    id: crypto
      .createHash('sha256')
      .update('agent-device-claim-root-v2\0')
      .update(canonicalPath)
      .update('\0')
      .update(identity.device)
      .update('\0')
      .update(identity.inode)
      .digest('hex'),
    ...identity,
  });
  assertDeviceClaimRoot(root);
  return root;
}

export function assertDeviceClaimRoot(root: DeviceClaimRoot): void {
  const current = lstatClaimRoot(root.path);
  assertPrivateClaimRoot(current);
  if (String(current.dev) !== root.device || String(current.ino) !== root.inode) {
    throw claimRootRefusal('identity_changed', root.id);
  }
  assertNoLegacyClaimFiles(root);
}

const LEGACY_DEVICE_CLAIM_ENTRY_NAME = /^[a-f0-9]{64}\.json(?:\.lock)?$/u;

/**
 * An unscoped predecessor claim may still be owned by an older daemon. It
 * cannot be renamed safely in place, so mixed-format roots require an
 * operator-controlled clean-root cutover. Repeat the check before every claim
 * effect instead of trusting only the initial root open.
 */
function assertNoLegacyClaimFiles(root: DeviceClaimRoot): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(root.path);
  } catch {
    throw claimRootRefusal('unreadable', root.id);
  }
  if (entries.some((entry) => LEGACY_DEVICE_CLAIM_ENTRY_NAME.test(entry))) {
    throw claimRootRefusal('legacy_claim_format', root.id);
  }
}

function lstatClaimRoot(rootPath: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(rootPath);
  } catch (error) {
    throw claimRootRefusal(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
    );
  }
  if (stat.isSymbolicLink()) throw claimRootRefusal('symlink');
  if (!stat.isDirectory()) throw claimRootRefusal('not_directory');
  return stat;
}

function assertPrivateClaimRoot(stat: fs.Stats): void {
  if (typeof process.getuid !== 'function') return;
  if (stat.uid !== process.getuid()) throw claimRootRefusal('wrong_owner');
  if ((stat.mode & 0o077) !== 0) throw claimRootRefusal('unsafe_mode');
}

function sameFsIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function claimRootRefusal(reason: string, rootId?: string): AppError {
  if (reason === 'legacy_claim_format') {
    return new AppError(
      'COMMAND_FAILED',
      'The device-claim root contains predecessor claim entries and requires a clean-root cutover.',
      {
        reason: 'device_claim_root_legacy_claim_format',
        ...(rootId ? { rootId } : {}),
        migration: 'clean-root-required',
        legacyFormat: 'unscoped-v1',
        hint: 'Stop every agent-device daemon using this claim root and reconcile or close its sessions. Then archive or remove the predecessor <hash>.json and <hash>.json.lock entries, or configure a new empty private deviceClaimsDir. Never delete a live claim.',
      },
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    'The device-claim root is not a stable private directory.',
    {
      reason: `device_claim_root_${reason}`,
      ...(rootId ? { rootId } : {}),
    },
  );
}

export function deviceClaimBindingId(root: DeviceClaimRoot, ...parts: string[]): string {
  const hash = crypto
    .createHash('sha256')
    .update('agent-device-claim-binding-v2\0')
    .update(root.id);
  for (const part of parts) hash.update('\0').update(part);
  return hash.digest('hex');
}
