import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { outdatedCache } from '../package-health/route';
import { detectPackageManager } from '@/lib/patch-scanner';

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

    const pm = detectPackageManager(cwd);

    if (!pm) {
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
      const outdatedCmd = pm === 'pnpm'
        ? 'pnpm outdated --format json'
        : pm === 'npm'
        ? 'npm outdated --json'
        : 'yarn outdated --json';

      try {
        const { stdout } = await execAsync(outdatedCmd, { cwd });
        outdatedOutput = stdout;
      } catch (err: unknown) {
        // These commands return non-zero exit code if outdated packages found
        const execErr = err as { stdout?: string };
        outdatedOutput = execErr.stdout || '{}';
      }

      // Parse outdated output - strip any warnings before JSON
      const jsonStart = outdatedOutput.search(/[\[{]/);
      const jsonOutput = jsonStart >= 0 ? outdatedOutput.slice(jsonStart) : '{}';
      const outdatedData = JSON.parse(jsonOutput);

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
    const cmd = pm === 'pnpm' ? 'pnpm outdated' : pm === 'npm' ? 'npm outdated' : 'yarn outdated';
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
