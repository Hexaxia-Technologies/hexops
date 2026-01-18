import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

interface UpdateRequestBody {
  packages?: string[]; // Specific packages to update to latest
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
        output: `No lockfile found in ${cwd}\n\nRun one of these commands first:\n  pnpm install\n  npm install\n  yarn install`,
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

    let output = '';

    if (packages.length > 0) {
      // Update specific packages to latest
      output = `Updating ${packages.length} package(s) to latest versions...\n\n`;

      for (const pkg of packages) {
        // Sanitize package name to prevent command injection
        if (!/^[@a-z0-9][\w\-./]*$/i.test(pkg)) {
          output += `Skipping invalid package name: ${pkg}\n`;
          continue;
        }

        let installCmd: string;
        if (packageManager === 'pnpm') {
          installCmd = `pnpm add ${pkg}@latest`;
        } else if (packageManager === 'npm') {
          installCmd = `npm install ${pkg}@latest`;
        } else {
          installCmd = `yarn add ${pkg}@latest`;
        }

        try {
          output += `$ ${installCmd}\n`;
          const { stdout, stderr } = await execAsync(installCmd, {
            cwd,
            timeout: 60000,
          });
          output += stdout + (stderr ? stderr : '') + '\n';
        } catch (err) {
          const execErr = err as { stdout?: string; stderr?: string; message?: string };
          output += `Error: ${execErr.message || 'Failed'}\n`;
          output += execErr.stdout || '';
          output += execErr.stderr || '';
          output += '\n';
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

      const { stdout, stderr } = await execAsync(cmd, {
        cwd,
        timeout: 120000,
      });

      output = stdout + (stderr ? `\n${stderr}` : '');
    }

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
