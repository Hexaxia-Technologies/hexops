import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';

export async function POST(
  request: NextRequest,
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

    const cachePath = join(project.path, '.next', 'cache');

    if (!existsSync(cachePath)) {
      return NextResponse.json({
        success: true,
        message: 'No cache to clear',
      });
    }

    rmSync(cachePath, { recursive: true, force: true });

    return NextResponse.json({
      success: true,
      message: `Cleared cache for ${project.name}`,
    });
  } catch (error) {
    console.error('Error clearing cache:', error);
    return NextResponse.json(
      { error: 'Failed to clear cache' },
      { status: 500 }
    );
  }
}
