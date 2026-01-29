import { NextResponse } from 'next/server';
import { getProjectSettings, updateProjectSettings } from '@/lib/settings';
import { getProject } from '@/lib/config';
import type { ProjectSettings } from '@/lib/types';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;

    const project = getProject(id);
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const settings = getProjectSettings(id);
    return NextResponse.json(settings);
  } catch (error) {
    console.error('Failed to get project settings:', error);
    return NextResponse.json(
      { error: 'Failed to get project settings' },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;

    const project = getProject(id);
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const body = await request.json() as Partial<ProjectSettings>;
    const updated = updateProjectSettings(id, body);
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update project settings:', error);
    return NextResponse.json(
      { error: 'Failed to update project settings' },
      { status: 500 }
    );
  }
}
