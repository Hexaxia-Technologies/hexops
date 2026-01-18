import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { startProject } from '@/lib/process-manager';
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

    // Check if already running
    const isRunning = await checkPort(project.port);
    if (isRunning) {
      return NextResponse.json(
        { error: 'Project is already running', status: 'running' },
        { status: 400 }
      );
    }

    const result = startProject(project);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Starting ${project.name} on port ${project.port}`,
    });
  } catch (error) {
    console.error('Error starting project:', error);
    return NextResponse.json(
      { error: 'Failed to start project' },
      { status: 500 }
    );
  }
}
