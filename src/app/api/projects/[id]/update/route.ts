import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  addPatchHistoryEntry,
  generatePatchId,
  invalidateProjectCache,
} from '@/lib/patch-storage';
import { getUpdateType, detectPackageManager } from '@/lib/patch-scanner';
import { invalidatePackageStatusCache } from '@/lib/extended-status';
import { clearInMemoryCache } from '@/app/api/projects/[id]/package-health/route';
import { logger } from '@/lib/logger';
import type { PatchHistoryEntry } from '@/lib/types';

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

interface UpdateRequestBody {
  packages?: Array<{
    name: string;
    fromVersion?: string;
    toVersion: string;
  }>;
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

    // Detect package manager from lockfile (newest lockfile wins when multiple exist)
    const packageManager = detectPackageManager(cwd);

    if (!packageManager) {
      return NextResponse.json({
        success: false,
        error: 'No lockfile found. Run install first.',
        output: `No lockfile found in ${cwd}`,
      });
    }

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

    // Pre-flight: check node_modules health for npm projects before batch updates
    if (packageManager === 'npm' && packages.length > 1) {
      const health = await checkNodeModulesHealth(cwd);
      if (!health.healthy) {
        logger.warn('patches', 'preflight_unhealthy', `${health.reason} in ${id}, running clean reinstall`, {
          projectId: id,
        });
        await cleanNodeModules(cwd);
      }
    }

    if (packages.length > 0) {
      // Validate all packages first
      const validPackages: Array<{ name: string; fromVersion?: string; targetVersion: string }> = [];
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
        validPackages.push({ name: pkg.name, fromVersion: pkg.fromVersion, targetVersion });
      }

      if (validPackages.length > 0) {
        // Build batched install command — single tree resolution for all packages
        const pkgSpecs = validPackages.map(p => `${p.name}@${p.targetVersion}`);
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

        if (batchSuccess) {
          // Batch succeeded — record success for all packages
          for (const pkg of validPackages) {
            results.push({ package: pkg.name, success: true, output: batchOutput });

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
              output: batchOutput,
            });
          }
        } else {
          // Batch failed — fall back to sequential installs to identify which packages fail
          logger.warn('patches', 'batch_fallback', `Batch install failed for ${id}, falling back to sequential`, {
            projectId: id,
          });

          for (const pkg of validPackages) {
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

    // Invalidate caches for this project
    invalidateProjectCache(id);
    invalidatePackageStatusCache(cwd);
    clearInMemoryCache(id);

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
