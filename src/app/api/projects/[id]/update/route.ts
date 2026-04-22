import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  addPatchHistoryEntry,
  generatePatchId,
  invalidateProjectCache,
} from '@/lib/patch-storage';
import { getUpdateType, detectPackageManager } from '@/lib/patch-scanner';
import { resolveLockfile } from '@/lib/lockfile-resolver';
import { getGlobalSettings, getProjectSettings } from '@/lib/settings';
import { invalidatePackageStatusCache } from '@/lib/extended-status';
import { clearInMemoryCache } from '@/app/api/projects/[id]/package-health/route';
import { logger } from '@/lib/logger';
import type { PatchHistoryEntry, LockfileResolutionMode } from '@/lib/types';

const execAsync = promisify(exec);

const NPM_INSTALL_TIMEOUT = 120000; // 2 minutes per package
const ARBORIST_ERROR_PATTERNS = [
  'ERESOLVE',
  "Cannot read properties of null",
  'TypeError: Cannot read properties',
];

function isArboristError(stderr: string, message?: string): boolean {
  const text = `${stderr}\n${message || ''}`;
  return ARBORIST_ERROR_PATTERNS.some(pattern => text.includes(pattern));
}

async function checkNodeModulesHealth(cwd: string): Promise<{ healthy: boolean; reason?: string }> {
  try {
    const { stderr } = await execAsync('npm ls --depth=0 --json 2>&1 || true', {
      cwd,
      timeout: 30000,
    });
    if (stderr.includes('Cannot read properties of null') || stderr.includes('ERR!')) {
      return { healthy: false, reason: 'Corrupted dependency tree detected' };
    }
    return { healthy: true };
  } catch {
    return { healthy: false, reason: 'Unable to read dependency tree' };
  }
}

async function cleanNodeModules(cwd: string): Promise<boolean> {
  try {
    await execAsync('rm -rf node_modules package-lock.json', { cwd, timeout: 30000 });
    await execAsync('npm install --legacy-peer-deps', { cwd, timeout: 180000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check pnpm lockfile health by running a dry-run install.
 * Returns healthy:false when the lockfile has missing or broken entries
 * (e.g., cross-platform optional deps like @next/swc-darwin-arm64).
 */
async function checkPnpmLockfileHealth(cwd: string): Promise<{ healthy: boolean; reason?: string }> {
  try {
    const { stdout, stderr } = await execAsync('pnpm install --frozen-lockfile 2>&1 || true', {
      cwd,
      timeout: 60000,
    });
    const output = `${stdout}\n${stderr}`;
    if (output.includes('ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY') || output.includes('ERR_PNPM_OUTDATED_LOCKFILE')) {
      const errorMatch = output.match(/ERR_PNPM_\w+/);
      return { healthy: false, reason: errorMatch?.[0] || 'Broken pnpm lockfile' };
    }
    return { healthy: true };
  } catch {
    return { healthy: false, reason: 'Unable to verify pnpm lockfile' };
  }
}

/**
 * Regenerate pnpm lockfile by deleting and reinstalling.
 * This fixes cross-platform issues (e.g., darwin-arm64 entries on Linux)
 * and corrupted merge conflict artifacts.
 */
async function repairPnpmLockfile(cwd: string): Promise<boolean> {
  try {
    await execAsync('rm -f pnpm-lock.yaml', { cwd, timeout: 5000 });
    await execAsync('pnpm install --no-frozen-lockfile', { cwd, timeout: 180000 });
    return true;
  } catch {
    return false;
  }
}

interface UpdateRequestBody {
  packages?: Array<{
    name: string;
    fromVersion?: string;
    toVersion: string;
    fixViaOverride?: boolean;
    fixByParent?: { name: string; version: string };
  }>;
  lockfileResolution?: LockfileResolutionMode;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body: UpdateRequestBody = await request.json().catch(() => ({}));
    const packages = body.packages || [];

    const project = getProject(id);

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const cwd = project.path;

    // Determine lockfile resolution mode
    const projectSettings = getProjectSettings(id);
    const globalSettings = getGlobalSettings();
    const resolutionMode: LockfileResolutionMode =
      body.lockfileResolution ??
      (projectSettings.patching?.lockfileResolution === 'global'
        ? globalSettings.patching?.defaultLockfileResolution
        : projectSettings.patching?.lockfileResolution as LockfileResolutionMode) ??
      'clean-slate';

    // Run lockfile resolution before attempting patches
    const resolution = await resolveLockfile(cwd, resolutionMode);
    if (!resolution.success) {
      return NextResponse.json({
        success: false,
        error: `Lockfile resolution (${resolutionMode}) failed`,
        resolution,
      }, { status: 500 });
    }

    // Use the resolved package manager
    const packageManager = resolution.packageManager;

    // Check if this is a workspace project (has workspaces in package.json)
    let isWorkspaceProject = false;
    try {
      const pkgJsonPath = join(cwd, 'package.json');
      if (existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        isWorkspaceProject = Array.isArray(pkgJson.workspaces) && pkgJson.workspaces.length > 0;
      }
    } catch {
      // Ignore errors reading package.json
    }

    const results: Array<{
      package: string;
      success: boolean;
      output: string;
      error?: string;
    }> = [];

    // Pre-flight: check dependency tree health before batch updates
    if (packageManager === 'npm' && packages.length > 1) {
      const health = await checkNodeModulesHealth(cwd);
      if (!health.healthy) {
        logger.warn('patches', 'preflight_unhealthy', `${health.reason} in ${id}, running clean reinstall`, {
          projectId: id,
        });
        await cleanNodeModules(cwd);
      }
    } else if (packageManager === 'pnpm') {
      const health = await checkPnpmLockfileHealth(cwd);
      if (!health.healthy) {
        logger.warn('patches', 'preflight_lockfile_broken', `${health.reason} in ${id}, regenerating lockfile`, {
          projectId: id,
        });
        const repaired = await repairPnpmLockfile(cwd);
        if (repaired) {
          logger.info('patches', 'lockfile_repaired', `pnpm lockfile regenerated for ${id}`, { projectId: id });
        } else {
          logger.error('patches', 'lockfile_repair_failed', `Failed to regenerate pnpm lockfile for ${id}`, { projectId: id });
        }
      }
    }

    if (packages.length > 0) {
      // Validate all packages first
      const validPackages: Array<{ name: string; fromVersion?: string; targetVersion: string; fixViaOverride?: boolean; fixByParent?: { name: string; version: string } }> = [];
      for (const pkg of packages) {
        if (!/^[@a-z0-9][\w\-./@]*$/i.test(pkg.name)) {
          results.push({ package: pkg.name, success: false, output: '', error: 'Invalid package name' });
          continue;
        }
        const targetVersion = pkg.toVersion || 'latest';
        if (!/^(latest|next|canary|[\w\-.^~<>=|@]+)$/i.test(targetVersion)) {
          results.push({ package: pkg.name, success: false, output: '', error: 'Invalid version specifier' });
          continue;
        }
        validPackages.push({ name: pkg.name, fromVersion: pkg.fromVersion, targetVersion, fixViaOverride: pkg.fixViaOverride, fixByParent: pkg.fixByParent });
      }

      // Filter out transitive dependencies — only allow updates to packages
      // that are actual direct dependencies in the project's package.json.
      // Without this guard, `pnpm add <transitive-dep>` silently promotes the
      // package to a direct dependency without actually fixing the vulnerability.
      let directDeps: Set<string> = new Set();
      try {
        const pkgJsonPath = join(cwd, 'package.json');
        if (existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
          const deps = Object.keys(pkgJson.dependencies || {});
          const devDeps = Object.keys(pkgJson.devDependencies || {});
          directDeps = new Set([...deps, ...devDeps]);
        }
      } catch {
        // If we can't read package.json, skip the guard (fail open)
      }

      const transitivePkgs: typeof validPackages = [];
      const overridePkgs: typeof validPackages = [];
      const directPkgs: typeof validPackages = [];

      if (directDeps.size > 0) {
        for (const pkg of validPackages) {
          if (directDeps.has(pkg.name)) {
            directPkgs.push(pkg);
          } else if (pkg.fixByParent && directDeps.has(pkg.fixByParent.name)) {
            // Transitive dep fixable by updating its parent direct dependency
            // Deduplicate: don't add the same parent twice
            const alreadyQueued = directPkgs.some(p => p.name === pkg.fixByParent!.name);
            if (!alreadyQueued) {
              directPkgs.push({
                name: pkg.fixByParent.name,
                fromVersion: undefined,
                targetVersion: pkg.fixByParent.version,
              });
            }
            logger.info('patches', 'fix_via_parent', `Fixing ${pkg.name} by updating parent ${pkg.fixByParent.name}@${pkg.fixByParent.version}`, {
              projectId: id,
              meta: { transitiveDep: pkg.name, parent: pkg.fixByParent.name, parentVersion: pkg.fixByParent.version },
            });
          } else if (pkg.fixViaOverride) {
            overridePkgs.push(pkg);
          } else {
            transitivePkgs.push(pkg);
            results.push({
              package: pkg.name,
              success: false,
              output: '',
              error: `Skipped: ${pkg.name} is a transitive dependency and cannot be updated directly. Update the parent package that depends on it, or add a package manager override.`,
            });
            logger.warn('patches', 'transitive_dep_skipped', `Skipped transitive dep ${pkg.name} in ${id} — not in dependencies/devDependencies`, {
              projectId: id,
              meta: { package: pkg.name, targetVersion: pkg.targetVersion },
            });
          }
        }
      } else {
        // Couldn't determine direct deps — allow all (fail open)
        directPkgs.push(...validPackages);
      }

      // Apply package manager overrides for transitive dependencies with known fixes
      if (overridePkgs.length > 0) {
        // Resolve "resolve-latest" versions by querying the registry
        for (const pkg of overridePkgs) {
          if (pkg.targetVersion === 'resolve-latest') {
            try {
              const viewCmd = packageManager === 'pnpm'
                ? `pnpm view ${pkg.name} version`
                : packageManager === 'yarn'
                ? `yarn info ${pkg.name} version`
                : `npm view ${pkg.name} version`;
              const { stdout } = await execAsync(viewCmd, { cwd, timeout: 15000 });
              const resolved = stdout.trim();
              if (resolved && /^\d+\.\d+\.\d+/.test(resolved)) {
                pkg.targetVersion = resolved;
              } else {
                pkg.targetVersion = 'latest';
              }
            } catch {
              // Fallback: use 'latest' — package managers can usually resolve this
              pkg.targetVersion = 'latest';
            }
          }
        }

        try {
          const pkgJsonPath = join(cwd, 'package.json');
          const pkgJsonRaw = readFileSync(pkgJsonPath, 'utf-8');
          const pkgJson = JSON.parse(pkgJsonRaw);

          // Write overrides using the correct key for each package manager
          if (packageManager === 'pnpm') {
            if (!pkgJson.pnpm) pkgJson.pnpm = {};
            if (!pkgJson.pnpm.overrides) pkgJson.pnpm.overrides = {};
            for (const pkg of overridePkgs) {
              pkgJson.pnpm.overrides[pkg.name] = pkg.targetVersion;
            }
          } else if (packageManager === 'npm') {
            if (!pkgJson.overrides) pkgJson.overrides = {};
            for (const pkg of overridePkgs) {
              pkgJson.overrides[pkg.name] = pkg.targetVersion;
            }
          } else {
            // yarn uses "resolutions"
            if (!pkgJson.resolutions) pkgJson.resolutions = {};
            for (const pkg of overridePkgs) {
              pkgJson.resolutions[pkg.name] = pkg.targetVersion;
            }
          }

          // Write package.json back, preserving indentation
          const indent = pkgJsonRaw.match(/^(\s+)/m)?.[1] || '  ';
          writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, indent) + '\n', 'utf-8');

          // Run install to apply the overrides
          const installCmd = packageManager === 'pnpm'
            ? 'pnpm install --no-frozen-lockfile'
            : packageManager === 'npm'
            ? 'npm install --legacy-peer-deps'
            : 'yarn install';

          let installOutput = '';
          try {
            const installResult = await execAsync(installCmd, { cwd, timeout: NPM_INSTALL_TIMEOUT });
            installOutput = `$ ${installCmd}\n${installResult.stdout || ''}${installResult.stderr || ''}`;
          } catch (installErr) {
            const err = installErr as { stdout?: string; stderr?: string; message?: string };
            installOutput = `$ ${installCmd}\n${err.stdout || ''}${err.stderr || ''}`;
            // Check if it looks like it worked despite exit code
            const looksInstalled = (err.stdout || '').includes('added') || (err.stdout || '').includes('done');
            if (!looksInstalled) {
              throw new Error(err.stderr || err.message || 'Install after override failed');
            }
          }

          for (const pkg of overridePkgs) {
            results.push({
              package: pkg.name,
              success: true,
              output: `Applied override: ${pkg.name}@${pkg.targetVersion}\n${installOutput}`,
            });
            logger.info('patches', 'override_applied', `Applied override for ${pkg.name}@${pkg.targetVersion}`, {
              projectId: id,
              meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, packageManager, mechanism: 'override' },
            });
            addPatchHistoryEntry({
              id: generatePatchId(),
              timestamp: new Date().toISOString(),
              projectId: id,
              package: pkg.name,
              fromVersion: pkg.fromVersion || 'unknown',
              toVersion: pkg.targetVersion,
              updateType: pkg.fromVersion ? getUpdateType(pkg.fromVersion, pkg.targetVersion) : 'patch',
              trigger: 'manual',
              success: true,
              output: `Override applied: ${pkg.name}@${pkg.targetVersion}`,
            });
          }
        } catch (err) {
          const overrideErr = err as { message?: string };
          for (const pkg of overridePkgs) {
            results.push({
              package: pkg.name,
              success: false,
              output: '',
              error: `Failed to apply override: ${overrideErr.message}`,
            });
            logger.error('patches', 'override_failed', `Failed to apply override for ${pkg.name}: ${overrideErr.message}`, {
              projectId: id,
              meta: { package: pkg.name },
            });
          }
        }
      }

      if (directPkgs.length > 0) {
        // Build batched install command — single tree resolution for all packages
        const pkgSpecs = directPkgs.map(p => `${p.name}@${p.targetVersion}`);
        let batchCmd: string;
        if (packageManager === 'pnpm') {
          const specs = pkgSpecs.join(' ');
          batchCmd = isWorkspaceProject ? `pnpm add ${specs} -r` : `pnpm add ${specs}`;
        } else if (packageManager === 'npm') {
          const specs = pkgSpecs.join(' ');
          batchCmd = isWorkspaceProject
            ? `npm install ${specs} --legacy-peer-deps --workspaces --include-workspace-root`
            : `npm install ${specs} --legacy-peer-deps`;
        } else {
          const specs = pkgSpecs.join(' ');
          batchCmd = isWorkspaceProject
            ? `yarn workspaces foreach add ${specs}`
            : `yarn add ${specs}`;
        }

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

          // Check if it looks like it worked despite exit code (postinstall warnings etc.)
          const looksInstalled =
            batchStdout.includes('added') ||
            batchStdout.includes('changed') ||
            batchStdout.includes('up to date');

          if (looksInstalled) {
            batchSuccess = true;
          } else if (packageManager === 'npm' && isArboristError(batchStderr, err.message)) {
            // Arborist crash — clean reinstall then retry batch
            logger.warn('patches', 'arborist_error', `Arborist error on batch install, attempting clean reinstall`, {
              projectId: id,
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
                const retryErrObj = retryErr as { stdout?: string; stderr?: string };
                batchStdout = retryErrObj.stdout || '';
                batchStderr = retryErrObj.stderr || '';
              }
            }
          }
        }

        const batchOutput = `$ ${batchCmd}\n${batchStdout}${batchStderr ? batchStderr : ''}`;

        // Even when pnpm exits 0, check for known error patterns in output
        // (pnpm can exit 0 with ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY, leaving
        // the package specifier updated in package.json but not actually installed)
        if (batchSuccess && batchStdout.includes('ERR_PNPM_')) {
          const pnpmError = batchStdout.match(/ERR_PNPM_\w+/)?.[0] || 'ERR_PNPM_UNKNOWN';
          logger.warn('patches', 'pnpm_soft_failure', `pnpm exited 0 but output contains error: ${pnpmError}`, {
            projectId: id,
            meta: { packages: pkgSpecs.join(', ') },
          });

          // Attempt lockfile repair and retry the batch
          if (packageManager === 'pnpm' && pnpmError.includes('LOCKFILE')) {
            logger.info('patches', 'lockfile_repair_retry', `Repairing lockfile and retrying batch for ${id}`, { projectId: id });
            const repaired = await repairPnpmLockfile(cwd);
            if (repaired) {
              try {
                const retryResult = await execAsync(batchCmd, { cwd, timeout: NPM_INSTALL_TIMEOUT });
                batchStdout = retryResult.stdout || '';
                batchStderr = retryResult.stderr || '';
                // Re-check for errors after retry
                if (!batchStdout.includes('ERR_PNPM_')) {
                  batchSuccess = true;
                  logger.info('patches', 'retry_succeeded', `Batch install succeeded after lockfile repair for ${id}`, { projectId: id });
                } else {
                  batchSuccess = false;
                }
              } catch (retryErr) {
                const err = retryErr as { stdout?: string; stderr?: string };
                batchStdout = err.stdout || '';
                batchStderr = err.stderr || '';
                batchSuccess = false;
              }
            } else {
              batchSuccess = false;
            }
          } else {
            batchSuccess = false;
          }
        }

        if (batchSuccess) {
          // Batch succeeded — verify actual install by checking installed versions
          for (const pkg of directPkgs) {
            let verified = true;
            try {
              const pkgJsonPath = join(cwd, 'node_modules', pkg.name, 'package.json');
              if (existsSync(pkgJsonPath)) {
                const installed = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
                const isFloatingTarget = /^(latest|next|canary)$/.test(pkg.targetVersion);
                if (installed.version === pkg.fromVersion && !isFloatingTarget) {
                  // Version didn't change and we had a pinned target — install silently failed
                  verified = false;
                  logger.warn('patches', 'version_unchanged', `${pkg.name} still at ${installed.version} after install`, {
                    projectId: id,
                    meta: { package: pkg.name, expected: pkg.targetVersion, actual: installed.version },
                  });
                }
              }
            } catch { /* ignore — can't verify, assume success */ }

            const success = verified;
            results.push({ package: pkg.name, success, output: batchOutput, error: success ? undefined : `Install reported success but ${pkg.name} version did not change` });

            if (success) {
              logger.info('patches', 'package_updated', `Updated ${pkg.name} to ${pkg.targetVersion}`, {
                projectId: id,
                meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, packageManager },
              });
            }

            addPatchHistoryEntry({
              id: generatePatchId(),
              timestamp: new Date().toISOString(),
              projectId: id,
              package: pkg.name,
              fromVersion: pkg.fromVersion || 'unknown',
              toVersion: pkg.targetVersion,
              updateType: pkg.fromVersion ? getUpdateType(pkg.fromVersion, pkg.targetVersion) : 'patch',
              trigger: 'manual',
              success,
              output: batchOutput,
              error: success ? undefined : `Version unchanged after install`,
            });
          }
        } else {
          // Batch failed — fall back to sequential installs to identify which packages fail
          logger.warn('patches', 'batch_fallback', `Batch install failed for ${id}, falling back to sequential`, {
            projectId: id,
          });

          for (const pkg of directPkgs) {
            let installCmd: string;
            if (packageManager === 'pnpm') {
              installCmd = isWorkspaceProject
                ? `pnpm add ${pkg.name}@${pkg.targetVersion} -r`
                : `pnpm add ${pkg.name}@${pkg.targetVersion}`;
            } else if (packageManager === 'npm') {
              installCmd = isWorkspaceProject
                ? `npm install ${pkg.name}@${pkg.targetVersion} --legacy-peer-deps --workspaces --include-workspace-root`
                : `npm install ${pkg.name}@${pkg.targetVersion} --legacy-peer-deps`;
            } else {
              installCmd = isWorkspaceProject
                ? `yarn workspaces foreach add ${pkg.name}@${pkg.targetVersion}`
                : `yarn add ${pkg.name}@${pkg.targetVersion}`;
            }

            try {
              const result = await execAsync(installCmd, { cwd, timeout: NPM_INSTALL_TIMEOUT });
              const output = `$ ${installCmd}\n${result.stdout || ''}${result.stderr || ''}`;

              results.push({ package: pkg.name, success: true, output });

              logger.info('patches', 'package_updated', `Updated ${pkg.name} to ${pkg.targetVersion}`, {
                projectId: id,
                meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, packageManager },
              });

              addPatchHistoryEntry({
                id: generatePatchId(),
                timestamp: new Date().toISOString(),
                projectId: id,
                package: pkg.name,
                fromVersion: pkg.fromVersion || 'unknown',
                toVersion: pkg.targetVersion,
                updateType: pkg.fromVersion ? getUpdateType(pkg.fromVersion, pkg.targetVersion) : 'patch',
                trigger: 'manual',
                success: true,
                output,
              });
            } catch (err) {
              const execErr = err as { stdout?: string; stderr?: string; message?: string };
              const stdout = execErr.stdout || '';
              const stderr = execErr.stderr || '';
              const output = `$ ${installCmd}\n${stdout}${stderr}`;
              const error = stderr || execErr.message || 'Update failed';

              // Check if it actually installed despite error
              const looksInstalled =
                stdout.includes('done') || stdout.includes('added') ||
                stdout.includes('changed') || stdout.includes('reused') ||
                stdout.includes('Already up to date');

              const success = looksInstalled;

              results.push({ package: pkg.name, success, output, error: success ? undefined : error });

              if (success) {
                logger.info('patches', 'package_updated', `Updated ${pkg.name} to ${pkg.targetVersion} (with warnings)`, {
                  projectId: id,
                  meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, packageManager },
                });
              } else {
                logger.error('patches', 'package_update_failed', `Failed to update ${pkg.name}: ${error}`, {
                  projectId: id,
                  meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, error },
                });
              }

              addPatchHistoryEntry({
                id: generatePatchId(),
                timestamp: new Date().toISOString(),
                projectId: id,
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
        }
      }
    } else {
      // No packages specified - run standard update within semver range
      let cmd: string;
      if (packageManager === 'pnpm') {
        cmd = isWorkspaceProject ? 'pnpm update -r' : 'pnpm update';
      } else if (packageManager === 'npm') {
        cmd = isWorkspaceProject
          ? 'npm update --legacy-peer-deps --workspaces --include-workspace-root'
          : 'npm update --legacy-peer-deps';
      } else {
        cmd = isWorkspaceProject ? 'yarn workspaces foreach upgrade' : 'yarn upgrade';
      }

      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd,
          timeout: 180000,
        });

        results.push({
          package: '*',
          success: true,
          output: stdout + (stderr ? `\n${stderr}` : ''),
        });
      } catch (err) {
        const execErr = err as { stdout?: string; stderr?: string; message?: string };
        results.push({
          package: '*',
          success: false,
          output: execErr.stdout || '',
          error: execErr.message || 'Update failed',
        });
      }
    }

    // Reconcile lockfile after updates to prevent CI frozen-lockfile failures
    // (pnpm add can update the lockfile specifier without updating package.json
    // when the existing range already satisfies the target version)
    const anySucceeded = results.some(r => r.success);
    if (anySucceeded) {
      try {
        const reconcileCmd = packageManager === 'pnpm'
          ? 'pnpm install --no-frozen-lockfile'
          : packageManager === 'npm'
          ? 'npm install --legacy-peer-deps'
          : 'yarn install';

        await execAsync(reconcileCmd, { cwd, timeout: NPM_INSTALL_TIMEOUT });
      } catch {
        // Non-fatal: lockfile may already be in sync
      }
    }

    // Invalidate caches and force a fresh rescan so the dashboard immediately
    // reflects the updated state (instead of serving stale pnpm outdated output)
    invalidateProjectCache(id);
    invalidatePackageStatusCache(cwd);
    clearInMemoryCache(id);

    if (anySucceeded) {
      try {
        const { scanProject } = await import('@/lib/patch-scanner');
        const { getProject: getProjectConfig } = await import('@/lib/config');
        const projectConfig = getProjectConfig(id);
        if (projectConfig) {
          await scanProject(projectConfig, true); // forceRefresh=true
        }
      } catch {
        // Non-fatal: cache will be rebuilt on next GET
      }
    }

    const allSucceeded = results.every(r => r.success);
    const output = results.map(r => r.output).join('\n\n');

    return NextResponse.json({
      success: allSucceeded,
      packageManager,
      results,
      output: output || 'Packages updated successfully.',
    });
  } catch (error) {
    console.error('Error updating packages:', error);
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    return NextResponse.json({
      success: false,
      error: 'Update command failed',
      output: execError.stdout || execError.stderr || execError.message || 'Unknown error',
    });
  }
}
