import path from 'node:path';
import {
  chmodHostFile,
  copyHostPath,
  hostFileLstat,
  hostTemporaryDirectory,
  makeHostTemporaryDirectory,
  readHostDirectory,
  removeHostPath,
} from '@agent-device/host-kit/host-file';
import { hostPlatform } from '@agent-device/host-kit/process';

// Apple's installer runs outside the caller's private temporary directory. Loan it a
// readable copy without changing the caller's bundle or traversing bundle symlinks.
export async function stageIosAppForInstaller(installPath: string): Promise<{
  installPath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await makeHostTemporaryDirectory(
    'agent-device-ios-install-',
    hostPlatform() === 'darwin' ? '/private/tmp' : hostTemporaryDirectory(),
  );
  const cleanup = async () => await removeHostPath(root);
  try {
    await chmodHostFile(root, 0o755);
    const stagedPath = path.join(root, path.basename(installPath));
    await copyHostPath(installPath, stagedPath, {
      overwrite: false,
      preserveTimestamps: false,
      verbatimSymlinks: true,
      clone: true,
    });
    await makeInstallerReadable(stagedPath);
    return { installPath: stagedPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function makeInstallerReadable(filePath: string): Promise<void> {
  const stat = await hostFileLstat(filePath);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmodHostFile(filePath, 0o755);
    for (const name of await readHostDirectory(filePath)) {
      await makeInstallerReadable(path.join(filePath, name));
    }
  } else if (stat.isFile()) {
    await chmodHostFile(filePath, stat.mode & 0o111 ? 0o755 : 0o644);
  }
}
