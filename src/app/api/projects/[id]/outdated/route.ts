import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
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

    try {
      // Try pnpm first, fall back to npm
      let outdatedOutput: string;
      try {
        const { stdout } = await execAsync('pnpm outdated --format json', { cwd });
        outdatedOutput = stdout;
      } catch (pnpmError: unknown) {
        // pnpm outdated returns non-zero exit code if outdated packages found
        const pnpmErr = pnpmError as { stdout?: string };
        if (pnpmErr.stdout) {
          outdatedOutput = pnpmErr.stdout;
        } else {
          // Try npm
          try {
            const { stdout } = await execAsync('npm outdated --json', { cwd });
            outdatedOutput = stdout;
          } catch (npmError: unknown) {
            const npmErr = npmError as { stdout?: string };
            outdatedOutput = npmErr.stdout || '{}';
          }
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

    // Cache the results
    outdatedCache.set(id, {
      data: outdatedInfo,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      success: true,
      outdated: outdatedInfo,
      count: Object.keys(outdatedInfo).length,
    });
  } catch (error) {
    console.error('Error checking outdated:', error);
    return NextResponse.json(
      { error: 'Failed to check outdated packages' },
      { status: 500 }
    );
  }
}
