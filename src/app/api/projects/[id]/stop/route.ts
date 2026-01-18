import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { stopProject } from '@/lib/process-manager';
import { checkPort } from '@/lib/port-checker';

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

    // Check if actually running
    const isRunning = await checkPort(project.port);
    if (!isRunning) {
      return NextResponse.json(
        { error: 'Project is not running', status: 'stopped' },
        { status: 400 }
      );
    }

    const result = stopProject(id, project.port);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Stopped ${project.name}`,
    });
  } catch (error) {
    console.error('Error stopping project:', error);
    return NextResponse.json(
      { error: 'Failed to stop project' },
      { status: 500 }
    );
  }
}
