import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

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

    // Check for lockfiles to determine which package manager to use
    const hasPnpmLock = existsSync(join(cwd, 'pnpm-lock.yaml'));
    const hasNpmLock = existsSync(join(cwd, 'package-lock.json'));
    const hasYarnLock = existsSync(join(cwd, 'yarn.lock'));

    if (!hasPnpmLock && !hasNpmLock && !hasYarnLock) {
      return NextResponse.json({
        success: false,
        error: 'No lockfile found. Run install first.',
        output: `No lockfile found in ${cwd}\n\nRun one of these commands first:\n  pnpm install\n  npm install\n  yarn install`,
      });
    }

    // Determine package manager and run update
    let cmd: string;
    let packageManager: string;

    if (hasPnpmLock) {
      cmd = 'pnpm update';
      packageManager = 'pnpm';
    } else if (hasNpmLock) {
      cmd = 'npm update';
      packageManager = 'npm';
    } else {
      cmd = 'yarn upgrade';
      packageManager = 'yarn';
    }

    // Run the update command
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: 120000, // 2 minute timeout for updates
    });

    const output = stdout + (stderr ? `\n${stderr}` : '');

    return NextResponse.json({
      success: true,
      packageManager,
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
