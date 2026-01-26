import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { getProjects } from '@/lib/config';

export async function POST(request: NextRequest) {
  try {
    const { path } = await request.json();

    if (!path || typeof path !== 'string') {
      return NextResponse.json({ error: 'Path is required' }, { status: 400 });
    }

    // Expand ~ to home directory
    const expandedPath = path.startsWith('~')
      ? path.replace('~', process.env.HOME || '')
      : path;

    // Check if path exists
    if (!existsSync(expandedPath)) {
      return NextResponse.json({ error: 'Path does not exist' }, { status: 400 });
    }

    // Try to read package.json
    const pkgPath = join(expandedPath, 'package.json');
    let packageJson: Record<string, unknown> | null = null;

    if (existsSync(pkgPath)) {
      try {
        packageJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      } catch {
        // Invalid JSON, continue without it
      }
    }

    // Get existing projects to suggest next port
    const existingProjects = getProjects();
    const maxPort = Math.max(...existingProjects.map(p => p.port), 2990);
    const suggestedPort = Math.ceil((maxPort + 10) / 10) * 10; // Round up to next 10

    // Extract info from package.json
    const scripts = packageJson?.scripts as Record<string, string> | undefined;

    // Generate ID from name or folder
    const name = (packageJson?.name as string) || basename(expandedPath);
    const suggestedId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return NextResponse.json({
      exists: true,
      path: expandedPath,
      name,
      description: (packageJson?.description as string) || '',
      suggestedPort,
      suggestedId,
      scripts: {
        dev: scripts?.dev || 'npm run dev',
        build: scripts?.build || 'npm run build',
      },
      availableScripts: scripts ? Object.keys(scripts) : [],
      hasPackageJson: !!packageJson,
    });
  } catch (error) {
    console.error('Error scanning path:', error);
    return NextResponse.json({ error: 'Failed to scan path' }, { status: 500 });
  }
}
