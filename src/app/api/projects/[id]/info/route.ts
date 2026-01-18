import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function GET(
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

    // Read package.json
    const packageJsonPath = join(project.path, 'package.json');
    const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    // Try to get node version
    let nodeVersion: string | undefined;
    try {
      const { stdout } = await execAsync('node --version', { cwd: project.path });
      nodeVersion = stdout.trim();
    } catch {
      // Node version check failed, that's ok
    }

    // Detect package manager
    let packageManager = 'npm';
    try {
      await readFile(join(project.path, 'pnpm-lock.yaml'), 'utf-8');
      packageManager = 'pnpm';
    } catch {
      try {
        await readFile(join(project.path, 'yarn.lock'), 'utf-8');
        packageManager = 'yarn';
      } catch {
        try {
          await readFile(join(project.path, 'bun.lockb'), 'utf-8');
          packageManager = 'bun';
        } catch {
          // Default to npm
        }
      }
    }

    return NextResponse.json({
      name: packageJson.name || project.name,
      version: packageJson.version || '0.0.0',
      description: packageJson.description,
      scripts: packageJson.scripts || {},
      nodeVersion,
      packageManager,
    });
  } catch (error) {
    console.error('Error fetching project info:', error);
    return NextResponse.json(
      { error: 'Failed to fetch project info' },
      { status: 500 }
    );
  }
}
