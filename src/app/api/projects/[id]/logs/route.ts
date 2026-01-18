import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { getLogs } from '@/lib/process-manager';

export async function GET(
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

    const logs = getLogs(id, 200);

    return NextResponse.json({
      projectId: id,
      logs,
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch logs' },
      { status: 500 }
    );
  }
}
