import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execAsync, NPM_INSTALL_TIMEOUT, type UpdatePackage, type UpdateResult } from './common';
import { buildNpmInstallCmd, isArboristError, cleanNodeModules } from './npm';
import { buildPnpmInstallCmd, repairPnpmLockfile } from './pnpm';
import { buildYarnInstallCmd } from './yarn';
import { addPatchHistoryEntry, generatePatchId } from '@/lib/patch-storage';
import { getUpdateType } from '@/lib/patch-scanner';
import { logger } from '@/lib/logger';

function buildBatchCmd(packageManager: string, specs: string[], isWorkspace: boolean): string {
  if (packageManager === 'pnpm') return buildPnpmInstallCmd(specs, isWorkspace);
  if (packageManager === 'npm') return buildNpmInstallCmd(specs, isWorkspace);
  return buildYarnInstallCmd(specs, isWorkspace);
}

function buildSingleCmd(packageManager: string, spec: string, isWorkspace: boolean): string {
  return buildBatchCmd(packageManager, [spec], isWorkspace);
}

/**
 * Rewrites the leading whitespace-delimited token of a shell command string.
 * Used to substitute the package-manager binary (e.g. 'pnpm' → 'aikido-pnpm')
 * when an installGate plugin is active.
 */
function applyBinOverride(cmd: string, override: string | undefined): string {
  if (!override) return cmd;
  return cmd.replace(/^\S+/, override);
}

function verifyInstalled(cwd: string, pkg: UpdatePackage): boolean {
  try {
    const nmPath = join(cwd, 'node_modules', pkg.name, 'package.json');
    if (!existsSync(nmPath)) return false;
    const installed = JSON.parse(readFileSync(nmPath, 'utf-8')).version;
    const isFloating = /^(latest|next|canary)$/.test(pkg.targetVersion);
    return isFloating ? !!installed : installed === pkg.targetVersion;
  } catch {
    return false;
  }
}

export async function installPackages(
  directPkgs: UpdatePackage[],
  packageManager: string,
  isWorkspace: boolean,
  cwd: string,
  projectId: string,
  /** Optional override for the install binary leading token (e.g. 'aikido-pnpm').
   *  When set, replaces the first whitespace-delimited token of every built install command
   *  so that an installGate plugin (e.g. Safe Chain) can interpose on the install. */
  installBinOverride?: string,
): Promise<UpdateResult[]> {
  const results: UpdateResult[] = [];
  const pkgSpecs = directPkgs.map(p => `${p.name}@${p.targetVersion}`);
  const batchCmd = applyBinOverride(buildBatchCmd(packageManager, pkgSpecs, isWorkspace), installBinOverride);

  let batchSuccess = false;
  let batchStdout = '';
  let batchStderr = '';

  try {
    const result = await execAsync(batchCmd, { cwd, timeout: NPM_INSTALL_TIMEOUT });
    batchStdout = result.stdout || '';
    batchStderr = result.stderr || '';
    batchSuccess = true;
  } catch (execErr) {
    const err = execErr as { stdout?: string; stderr?: string; message?: string };
    batchStdout = err.stdout || '';
    batchStderr = err.stderr || '';

    // Verify via actual node_modules reads rather than output string heuristics
    const anyVerified = directPkgs.some(p => verifyInstalled(cwd, p));
    if (anyVerified) {
      batchSuccess = true;
    } else if (packageManager === 'npm' && isArboristError(batchStderr, err.message)) {
      logger.warn('patches', 'arborist_error', `Arborist error on batch install, attempting clean reinstall`, {
        projectId,
        meta: { packages: pkgSpecs.join(', '), error: (batchStderr || err.message || '').slice(0, 500) },
      });
      const cleaned = await cleanNodeModules(cwd);
      if (cleaned) {
        try {
          const retryResult = await execAsync(batchCmd, { cwd, timeout: NPM_INSTALL_TIMEOUT });
          batchStdout = retryResult.stdout || '';
          batchStderr = retryResult.stderr || '';
          batchSuccess = true;
        } catch (retryErr) {
          const e = retryErr as { stdout?: string; stderr?: string };
          batchStdout = e.stdout || '';
          batchStderr = e.stderr || '';
        }
      }
    }
  }

  // pnpm can exit 0 while printing ERR_PNPM_* — detect soft failures
  if (batchSuccess && (batchStdout.includes('ERR_PNPM_') || batchStderr.includes('ERR_PNPM_'))) {
    const pnpmError = (batchStdout + batchStderr).match(/ERR_PNPM_\w+/)?.[0] || 'ERR_PNPM_UNKNOWN';
    logger.warn('patches', 'pnpm_soft_failure', `pnpm exited 0 but output contains error: ${pnpmError}`, {
      projectId,
      meta: { packages: pkgSpecs.join(', ') },
    });

    if (packageManager === 'pnpm' && pnpmError.includes('LOCKFILE')) {
      logger.info('patches', 'lockfile_repair_retry', `Repairing lockfile and retrying batch for ${projectId}`, { projectId });
      const repaired = await repairPnpmLockfile(cwd);
      if (repaired) {
        try {
          const retryResult = await execAsync(batchCmd, { cwd, timeout: NPM_INSTALL_TIMEOUT });
          batchStdout = retryResult.stdout || '';
          batchStderr = retryResult.stderr || '';
          batchSuccess = !batchStdout.includes('ERR_PNPM_');
          if (batchSuccess) logger.info('patches', 'retry_succeeded', `Batch install succeeded after lockfile repair for ${projectId}`, { projectId });
        } catch (retryErr) {
          const e = retryErr as { stdout?: string; stderr?: string };
          batchStdout = e.stdout || '';
          batchStderr = e.stderr || '';
          batchSuccess = false;
        }
      } else {
        batchSuccess = false;
      }
    } else {
      batchSuccess = false;
    }
  }

  const batchOutput = `$ ${batchCmd}\n${batchStdout}${batchStderr}`;

  if (batchSuccess) {
    for (const pkg of directPkgs) {
      let verified = true;
      try {
        const nmPath = join(cwd, 'node_modules', pkg.name, 'package.json');
        if (existsSync(nmPath)) {
          const installed = JSON.parse(readFileSync(nmPath, 'utf-8'));
          const isFloatingTarget = /^(latest|next|canary)$/.test(pkg.targetVersion);
          // "Version didn't change" is only a failure signal when it also
          // isn't already the requested version. Since route.ts started
          // passing the node_modules-read effectiveFromVersion (rather than
          // the often-absent raw request field) for requests that omit
          // fromVersion, fromVersion can now legitimately equal the
          // pre-install installed version in the benign "already at the
          // target, re-requested from a stale scan cache" case — the
          // downgrade guard upstream deliberately lets that case through
          // (strict `>` comparison), and a plain no-op reinstall correctly
          // leaves the version unchanged. Without this qualifier, that
          // benign case would report `success: false` even though the
          // package is exactly where it should be.
          if (installed.version === pkg.fromVersion && installed.version !== pkg.targetVersion && !isFloatingTarget) {
            verified = false;
            logger.warn('patches', 'version_unchanged', `${pkg.name} still at ${installed.version} after install`, {
              projectId,
              meta: { package: pkg.name, expected: pkg.targetVersion, actual: installed.version },
            });
          }
        }
      } catch { /* ignore */ }

      results.push({
        package: pkg.name,
        success: verified,
        output: batchOutput,
        error: verified ? undefined : `Install reported success but ${pkg.name} version did not change`,
      });

      if (verified) {
        logger.info('patches', 'package_updated', `Updated ${pkg.name} to ${pkg.targetVersion}`, {
          projectId,
          meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, packageManager },
        });
      }

      addPatchHistoryEntry({
        id: generatePatchId(),
        timestamp: new Date().toISOString(),
        projectId,
        package: pkg.name,
        fromVersion: pkg.fromVersion || 'unknown',
        toVersion: pkg.targetVersion,
        updateType: pkg.fromVersion ? getUpdateType(pkg.fromVersion, pkg.targetVersion) : 'patch',
        trigger: 'manual',
        success: verified,
        output: batchOutput,
        error: verified ? undefined : 'Version unchanged after install',
      });
    }
    return results;
  }

  // Batch failed — fall back to sequential
  logger.warn('patches', 'batch_fallback', `Batch install failed for ${projectId}, falling back to sequential`, { projectId });

  for (const pkg of directPkgs) {
    const installCmd = applyBinOverride(buildSingleCmd(packageManager, `${pkg.name}@${pkg.targetVersion}`, isWorkspace), installBinOverride);
    try {
      const result = await execAsync(installCmd, { cwd, timeout: NPM_INSTALL_TIMEOUT });
      const combinedOutput = (result.stdout || '') + (result.stderr || '');
      const output = `$ ${installCmd}\n${combinedOutput}`;
      // pnpm can exit 0 while printing ERR_PNPM_* — verify via node_modules
      const pnpmSoftFail = packageManager === 'pnpm' && combinedOutput.includes('ERR_PNPM_');
      const success = pnpmSoftFail ? verifyInstalled(cwd, pkg) : true;
      results.push({ package: pkg.name, success, output, error: success ? undefined : 'pnpm reported error despite exit 0' });
      if (!success) {
        logger.warn('patches', 'pnpm_soft_failure', `pnpm exited 0 but ${pkg.name} not installed correctly`, {
          projectId,
          meta: { package: pkg.name },
        });
      }
      if (success) logger.info('patches', 'package_updated', `Updated ${pkg.name} to ${pkg.targetVersion}`, {
        projectId,
        meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, packageManager },
      });
      addPatchHistoryEntry({
        id: generatePatchId(),
        timestamp: new Date().toISOString(),
        projectId,
        package: pkg.name,
        fromVersion: pkg.fromVersion || 'unknown',
        toVersion: pkg.targetVersion,
        updateType: pkg.fromVersion ? getUpdateType(pkg.fromVersion, pkg.targetVersion) : 'patch',
        trigger: 'manual',
        success,
        output,
      });
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      const stdout = execErr.stdout || '';
      const stderr = execErr.stderr || '';
      const output = `$ ${installCmd}\n${stdout}${stderr}`;
      const error = stderr || execErr.message || 'Update failed';

      const success = verifyInstalled(cwd, pkg);

      results.push({ package: pkg.name, success, output, error: success ? undefined : error });

      if (success) {
        logger.info('patches', 'package_updated', `Updated ${pkg.name} to ${pkg.targetVersion} (with warnings)`, {
          projectId,
          meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, packageManager },
        });
      } else {
        logger.error('patches', 'package_update_failed', `Failed to update ${pkg.name}: ${error}`, {
          projectId,
          meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, error },
        });
      }

      addPatchHistoryEntry({
        id: generatePatchId(),
        timestamp: new Date().toISOString(),
        projectId,
        package: pkg.name,
        fromVersion: pkg.fromVersion || 'unknown',
        toVersion: pkg.targetVersion,
        updateType: pkg.fromVersion ? getUpdateType(pkg.fromVersion, pkg.targetVersion) : 'patch',
        trigger: 'manual',
        success,
        output,
        error: success ? undefined : error,
      });
    }
  }

  return results;
}
