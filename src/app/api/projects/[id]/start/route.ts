import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { startProject, StartMode } from '@/lib/process-manager';
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

    // Parse request body for mode
    const body = await request.json().catch(() => ({}));
    const mode: StartMode = body.mode === 'prod' ? 'prod' : 'dev';

    // Check if already running
    const isRunning = await checkPort(project.port);
    if (isRunning) {
      return NextResponse.json(
        { error: 'Project is already running', status: 'running' },
        { status: 400 }
      );
    }

    const result = startProject(project, mode);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 500 }
      );
    }

    const modeLabel = mode === 'prod' ? 'production' : 'development';
    return NextResponse.json({
      success: true,
      message: `Starting ${project.name} in ${modeLabel} mode on port ${project.port}`,
      mode,
    });
  } catch (error) {
    console.error('Error starting project:', error);
    return NextResponse.json(
      { error: 'Failed to start project' },
      { status: 500 }
    );
  }
}
