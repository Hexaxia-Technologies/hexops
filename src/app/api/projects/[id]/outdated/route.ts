import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import { outdatedCache } from '../package-health/route';

const execAsync = promisify(exec);

interface OutdatedInfo {
  current: string;
  wanted: string;
  latest: string;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const project = getProject(id);

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const cwd = project.path;
    const outdatedInfo: Record<string, OutdatedInfo> = {};

    // Check for lockfiles to determine which package manager to use
    const hasPnpmLock = existsSync(join(cwd, 'pnpm-lock.yaml'));
    const hasNpmLock = existsSync(join(cwd, 'package-lock.json'));
    const hasYarnLock = existsSync(join(cwd, 'yarn.lock'));

    if (!hasPnpmLock && !hasNpmLock && !hasYarnLock) {
      // No lockfile found - return helpful message
      const rawOutput = `No lockfile found in ${cwd}

To check for outdated packages, run one of these commands in the project directory:
  pnpm install   (creates pnpm-lock.yaml)
  npm install    (creates package-lock.json)
  yarn install   (creates yarn.lock)`;

      return NextResponse.json({
        success: true,
        outdated: {},
        count: 0,
        rawOutput,
      });
    }

    try {
      // Use the appropriate package manager based on lockfile
      let outdatedOutput: string;

      if (hasPnpmLock) {
        try {
          const { stdout } = await execAsync('pnpm outdated --format json', { cwd });
          outdatedOutput = stdout;
        } catch (pnpmError: unknown) {
          // pnpm outdated returns non-zero exit code if outdated packages found
          const pnpmErr = pnpmError as { stdout?: string; stderr?: string };
          outdatedOutput = pnpmErr.stdout || '{}';
        }
      } else if (hasNpmLock) {
        try {
          const { stdout } = await execAsync('npm outdated --json', { cwd });
          outdatedOutput = stdout;
        } catch (npmError: unknown) {
          const npmErr = npmError as { stdout?: string };
          outdatedOutput = npmErr.stdout || '{}';
        }
      } else {
        // yarn
        try {
          const { stdout } = await execAsync('yarn outdated --json', { cwd });
          outdatedOutput = stdout;
        } catch (yarnError: unknown) {
          const yarnErr = yarnError as { stdout?: string };
          outdatedOutput = yarnErr.stdout || '{}';
        }
      }

      // Parse outdated output
      const outdatedData = JSON.parse(outdatedOutput || '{}');

      // pnpm format (array of objects)
      if (Array.isArray(outdatedData)) {
        outdatedData.forEach((pkg: { name: string; current: string; wanted: string; latest: string }) => {
          outdatedInfo[pkg.name] = {
            current: pkg.current,
            wanted: pkg.wanted,
            latest: pkg.latest,
          };
        });
      }
      // npm format (object with package names as keys)
      else if (typeof outdatedData === 'object') {
        Object.entries(outdatedData).forEach(([name, data]: [string, unknown]) => {
          const pkg = data as { current: string; wanted: string; latest: string };
          outdatedInfo[name] = {
            current: pkg.current,
            wanted: pkg.wanted,
            latest: pkg.latest,
          };
        });
      }
    } catch (error) {
      console.error('Outdated command failed:', error);
      // Continue with empty outdated info
    }

    // Get human-readable output for display
    let rawOutput = '';
    const cmd = hasPnpmLock ? 'pnpm outdated' : hasNpmLock ? 'npm outdated' : 'yarn outdated';
    try {
      const { stdout, stderr } = await execAsync(`${cmd} 2>&1 || true`, { cwd });
      rawOutput = stdout || stderr || 'All packages are up to date';
    } catch {
      rawOutput = 'Failed to get raw outdated output';
    }

    // Cache the results
    outdatedCache.set(id, {
      data: outdatedInfo,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      success: true,
      outdated: outdatedInfo,
      count: Object.keys(outdatedInfo).length,
      rawOutput,
    });
  } catch (error) {
    console.error('Error checking outdated:', error);
    return NextResponse.json(
      { error: 'Failed to check outdated packages' },
      { status: 500 }
    );
  }
}
