import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { stopProject } from '@/lib/process-manager';
import { checkPort } from '@/lib/port-checker';
import { logger } from '@/lib/logger';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
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

    // Log success
    logger.info('projects', 'project_stopped', `Stopped ${project.name}`, {
      projectId: id,
    });

    return NextResponse.json({
      success: true,
      message: `Stopped ${project.name}`,
    });
  } catch (error) {
    console.error('Error stopping project:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to stop project';

    // Log failure
    logger.error('projects', 'project_stop_failed', `Failed to stop project: ${errorMessage}`, {
      projectId: id,
      meta: { error: errorMessage },
    });

    return NextResponse.json(
      { error: 'Failed to stop project' },
      { status: 500 }
    );
  }
}
