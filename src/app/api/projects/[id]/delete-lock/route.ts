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

    const lockPath = join(project.path, '.next', 'dev', 'lock');

    if (!existsSync(lockPath)) {
      return NextResponse.json({
        success: true,
        message: 'No lock file found',
      });
    }

    rmSync(lockPath, { force: true });

    return NextResponse.json({
      success: true,
      message: `Deleted lock file for ${project.name}`,
    });
  } catch (error) {
    console.error('Error deleting lock:', error);
    return NextResponse.json(
      { error: 'Failed to delete lock file' },
      { status: 500 }
    );
  }
}
