import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'fs';
import { getProjects, getCategories, saveConfig } from '@/lib/config';
import type { ProjectConfig } from '@/lib/types';

interface SaveProjectRequest {
  project: ProjectConfig;
  isNew: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const body: SaveProjectRequest = await request.json();
    const { project, isNew } = body;

    // Validate required fields
    if (!project.id || !project.name || !project.path || !project.port || !project.category) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Validate ID format
    if (!/^[a-z0-9-]+$/.test(project.id)) {
      return NextResponse.json(
        { error: 'ID must contain only lowercase letters, numbers, and hyphens' },
        { status: 400 }
      );
    }

    // Validate port range
    if (project.port < 1024 || project.port > 65535) {
      return NextResponse.json(
        { error: 'Port must be between 1024 and 65535' },
        { status: 400 }
      );
    }

    // Validate path exists
    if (!existsSync(project.path)) {
      return NextResponse.json({ error: 'Project path does not exist' }, { status: 400 });
    }

    // Validate scripts
    if (!project.scripts?.dev || !project.scripts?.build) {
      return NextResponse.json(
        { error: 'Both dev and build scripts are required' },
        { status: 400 }
      );
    }

    const existingProjects = getProjects();
    const categories = getCategories();

    if (isNew) {
      // Check for duplicate ID
      if (existingProjects.some(p => p.id === project.id)) {
        return NextResponse.json({ error: 'Project ID already exists' }, { status: 400 });
      }
      // Check for duplicate port
      if (existingProjects.some(p => p.port === project.port)) {
        return NextResponse.json({ error: 'Port already in use by another project' }, { status: 400 });
      }
      existingProjects.push(project);
    } else {
      // Update existing
      const index = existingProjects.findIndex(p => p.id === project.id);
      if (index === -1) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      // Check port conflict (excluding self)
      if (existingProjects.some(p => p.port === project.port && p.id !== project.id)) {
        return NextResponse.json({ error: 'Port already in use by another project' }, { status: 400 });
      }
      existingProjects[index] = project;
    }

    // Add new category if needed
    const updatedCategories = categories.includes(project.category)
      ? categories
      : [...categories, project.category];

    saveConfig({ projects: existingProjects, categories: updatedCategories });

    return NextResponse.json({ success: true, project });
  } catch (error) {
    console.error('Error saving project:', error);
    return NextResponse.json({ error: 'Failed to save project' }, { status: 500 });
  }
}
