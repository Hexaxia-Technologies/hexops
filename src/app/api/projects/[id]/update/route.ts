import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  addPatchHistoryEntry,
  generatePatchId,
  invalidateProjectCache,
} from '@/lib/patch-storage';
import { getUpdateType } from '@/lib/patch-scanner';
import type { PatchHistoryEntry } from '@/lib/types';

const execAsync = promisify(exec);

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

    // Check for lockfiles to determine which package manager to use
    const hasPnpmLock = existsSync(join(cwd, 'pnpm-lock.yaml'));
    const hasNpmLock = existsSync(join(cwd, 'package-lock.json'));
    const hasYarnLock = existsSync(join(cwd, 'yarn.lock'));

    if (!hasPnpmLock && !hasNpmLock && !hasYarnLock) {
      return NextResponse.json({
        success: false,
        error: 'No lockfile found. Run install first.',
        output: `No lockfile found in ${cwd}`,
      });
    }

    // Determine package manager
    let packageManager: string;
    if (hasPnpmLock) {
      packageManager = 'pnpm';
    } else if (hasNpmLock) {
      packageManager = 'npm';
    } else {
      packageManager = 'yarn';
    }

    const results: Array<{
      package: string;
      success: boolean;
      output: string;
      error?: string;
    }> = [];

    if (packages.length > 0) {
      // Update specific packages
      for (const pkg of packages) {
        // Sanitize package name
        if (!/^[@a-z0-9][\w\-./@]*$/i.test(pkg.name)) {
          results.push({
            package: pkg.name,
            success: false,
            output: '',
            error: 'Invalid package name',
          });
          continue;
        }

        // Sanitize version - only allow valid semver-like versions
        const targetVersion = pkg.toVersion || 'latest';
        if (!/^(latest|next|canary|[\w\-.^~<>=|@]+)$/i.test(targetVersion)) {
          results.push({
            package: pkg.name,
            success: false,
            output: '',
            error: 'Invalid version specifier',
          });
          continue;
        }

        let installCmd: string;
        if (packageManager === 'pnpm') {
          installCmd = `pnpm add ${pkg.name}@${targetVersion}`;
        } else if (packageManager === 'npm') {
          installCmd = `npm install ${pkg.name}@${targetVersion}`;
        } else {
          installCmd = `yarn add ${pkg.name}@${targetVersion}`;
        }

        try {
          const { stdout, stderr } = await execAsync(installCmd, {
            cwd,
            timeout: 60000,
          });
          const output = `$ ${installCmd}\n${stdout}${stderr ? stderr : ''}`;

          results.push({
            package: pkg.name,
            success: true,
            output,
          });

          // Log to history
          const historyEntry: PatchHistoryEntry = {
            id: generatePatchId(),
            timestamp: new Date().toISOString(),
            projectId: id,
            package: pkg.name,
            fromVersion: pkg.fromVersion || 'unknown',
            toVersion: targetVersion,
            updateType: pkg.fromVersion
              ? getUpdateType(pkg.fromVersion, targetVersion)
              : 'patch',
            trigger: 'manual',
            success: true,
            output,
          };
          addPatchHistoryEntry(historyEntry);
        } catch (err) {
          const execErr = err as { stdout?: string; stderr?: string; message?: string };
          const output = `$ ${installCmd}\n${execErr.stdout || ''}${execErr.stderr || ''}`;
          const error = execErr.message || 'Update failed';

          results.push({
            package: pkg.name,
            success: false,
            output,
            error,
          });

          // Log failure to history
          const historyEntry: PatchHistoryEntry = {
            id: generatePatchId(),
            timestamp: new Date().toISOString(),
            projectId: id,
            package: pkg.name,
            fromVersion: pkg.fromVersion || 'unknown',
            toVersion: targetVersion,
            updateType: pkg.fromVersion
              ? getUpdateType(pkg.fromVersion, targetVersion)
              : 'patch',
            trigger: 'manual',
            success: false,
            output,
            error,
          };
          addPatchHistoryEntry(historyEntry);
        }
      }
    } else {
      // No packages specified - run standard update within semver range
      let cmd: string;
      if (packageManager === 'pnpm') {
        cmd = 'pnpm update';
      } else if (packageManager === 'npm') {
        cmd = 'npm update';
      } else {
        cmd = 'yarn upgrade';
      }

      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd,
          timeout: 120000,
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

    // Invalidate cache for this project
    invalidateProjectCache(id);

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
