import { existsSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { detectPackageManager, getDetectionSource } from './patch-scanner';
import { checkLockFileFreshness } from './lockfile-checker';
import type { LockfileResolutionMode, LockfileResolutionResult, PackageManager } from './types';

const LOCK_FILES: Record<PackageManager, string> = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
};

const INSTALL_CMD: Record<PackageManager, string> = {
  pnpm: 'pnpm install --no-frozen-lockfile',
  npm: 'npm install --legacy-peer-deps',
  yarn: 'yarn install',
};

export async function resolveLockfile(
  projectPath: string,
  mode: LockfileResolutionMode
): Promise<LockfileResolutionResult> {
  switch (mode) {
    case 'clean-slate':
      return cleanSlate(projectPath);
    case 'repair':
      return repair(projectPath);
    case 'preflight':
      return preflight(projectPath);
  }
}

/**
 * Mode A: Clean Slate
 * Delete lock file + node_modules, fresh install.
 */
async function cleanSlate(projectPath: string): Promise<LockfileResolutionResult> {
  const actions: string[] = [];
  const detectedVia = getDetectionSource(projectPath);
  const pm = detectPackageManager(projectPath);

  try {
    // Delete all lock files (there might be stale ones from a different PM)
    for (const [, lockFile] of Object.entries(LOCK_FILES)) {
      const lockPath = join(projectPath, lockFile);
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
        actions.push(`Deleted ${lockFile}`);
      }
    }

    // Delete node_modules
    const nmPath = join(projectPath, 'node_modules');
    if (existsSync(nmPath)) {
      rmSync(nmPath, { recursive: true, force: true });
      actions.push('Deleted node_modules/');
    }

    // Re-detect PM after deleting lock files (uses fallback strategies)
    const resolvedPm = detectPackageManager(projectPath);
    actions.push(`Detected package manager: ${resolvedPm} (via ${getDetectionSource(projectPath)})`);

    // Fresh install
    const cmd = INSTALL_CMD[resolvedPm];
    actions.push(`Running: ${cmd}`);
    execSync(cmd, {
      cwd: projectPath,
      stdio: 'pipe',
      timeout: 120_000,
      env: { ...process.env, NODE_ENV: 'development' },
    });
    actions.push('Fresh install completed');

    return {
      mode: 'clean-slate',
      success: true,
      packageManager: resolvedPm,
      detectedVia: getDetectionSource(projectPath),
      actions,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    actions.push(`Error: ${message}`);
    return {
      mode: 'clean-slate',
      success: false,
      packageManager: pm,
      detectedVia,
      actions,
      error: message,
    };
  }
}

/**
 * Mode B: Repair
 * Detect the issue, apply minimum fix, keep node_modules if possible.
 */
async function repair(projectPath: string): Promise<LockfileResolutionResult> {
  const actions: string[] = [];
  const pm = detectPackageManager(projectPath);
  const detectedVia = getDetectionSource(projectPath);

  try {
    const lockFile = LOCK_FILES[pm];
    const lockPath = join(projectPath, lockFile);

    // Step 1: Check if lock file exists
    if (!existsSync(lockPath)) {
      actions.push(`No ${lockFile} found, generating fresh lock file`);
      execSync(INSTALL_CMD[pm], {
        cwd: projectPath,
        stdio: 'pipe',
        timeout: 120_000,
      });
      actions.push('Lock file generated');
      return { mode: 'repair', success: true, packageManager: pm, detectedVia, actions };
    }

    // Step 2: Check freshness
    const freshness = checkLockFileFreshness(projectPath);
    if (freshness.mismatches.length > 0) {
      actions.push(`Found ${freshness.mismatches.length} stale entries in ${lockFile}`);
      for (const m of freshness.mismatches) {
        actions.push(`  ${m.package}: package.json=${m.packageJsonSpec} vs lock=${m.lockfileSpec}`);
      }
    } else {
      actions.push(`${lockFile} is in sync with package.json`);
    }

    // Step 3: Try install (with permissive flags)
    const cmd = INSTALL_CMD[pm];
    actions.push(`Running: ${cmd}`);
    try {
      execSync(cmd, {
        cwd: projectPath,
        stdio: 'pipe',
        timeout: 120_000,
      });
      actions.push('Install completed (lock file updated)');
    } catch {
      // Step 4: If install fails, delete just the lock file and retry
      actions.push('Install failed, regenerating lock file');
      unlinkSync(lockPath);
      actions.push(`Deleted ${lockFile}`);

      execSync(cmd, {
        cwd: projectPath,
        stdio: 'pipe',
        timeout: 120_000,
      });
      actions.push('Reinstall with fresh lock file completed');
    }

    return {
      mode: 'repair',
      success: true,
      packageManager: pm,
      detectedVia,
      actions,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    actions.push(`Error: ${message}`);
    return {
      mode: 'repair',
      success: false,
      packageManager: pm,
      detectedVia,
      actions,
      error: message,
    };
  }
}

/**
 * Mode C: Pre-flight Check
 * Validate lock file is installable. If not, report issues without fixing.
 */
async function preflight(projectPath: string): Promise<LockfileResolutionResult> {
  const actions: string[] = [];
  const pm = detectPackageManager(projectPath);
  const detectedVia = getDetectionSource(projectPath);
  const lockFile = LOCK_FILES[pm];
  const lockPath = join(projectPath, lockFile);

  // Check 1: Lock file exists
  if (!existsSync(lockPath)) {
    actions.push(`No ${lockFile} found — install required before patching`);
    return {
      mode: 'preflight',
      success: false,
      packageManager: pm,
      detectedVia,
      actions,
      error: `Missing ${lockFile}`,
    };
  }

  // Check 2: Freshness
  const freshness = checkLockFileFreshness(projectPath);
  if (freshness.mismatches.length > 0) {
    actions.push(`${freshness.mismatches.length} packages out of sync between package.json and ${lockFile}`);
    for (const m of freshness.mismatches) {
      actions.push(`  ${m.package}: package.json=${m.packageJsonSpec} vs lock=${m.lockfileSpec}`);
    }
  }

  // Check 3: Try a dry-run install
  try {
    if (pm === 'npm') {
      execSync('npm install --dry-run --legacy-peer-deps', {
        cwd: projectPath,
        stdio: 'pipe',
        timeout: 60_000,
      });
      actions.push('npm dry-run install: OK');
    } else if (pm === 'pnpm') {
      execSync('pnpm install --lockfile-only', {
        cwd: projectPath,
        stdio: 'pipe',
        timeout: 60_000,
      });
      actions.push('pnpm lockfile-only install: OK');
    } else {
      actions.push(`Dry-run not supported for ${pm}, skipping`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    actions.push(`Install check failed: ${message}`);
    return {
      mode: 'preflight',
      success: false,
      packageManager: pm,
      detectedVia,
      actions,
      error: `Lock file is not installable: ${message}`,
    };
  }

  const isHealthy = freshness.mismatches.length === 0;
  if (isHealthy) {
    actions.push('Lock file is healthy');
  } else {
    actions.push('Lock file has mismatches but is installable — recommend repair');
  }

  return {
    mode: 'preflight',
    success: true,
    packageManager: pm,
    detectedVia,
    actions,
  };
}
