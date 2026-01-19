import { NextRequest, NextResponse } from 'next/server';
import { getProjects, getCategories, saveConfig } from '@/lib/config';

interface HoldRequest {
  package: string;
}

// Add a package to holds
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body: HoldRequest = await request.json();
    const { package: packageName } = body;

    if (!packageName) {
      return NextResponse.json({ error: 'Package name is required' }, { status: 400 });
    }

    const projects = getProjects();
    const projectIndex = projects.findIndex(p => p.id === id);

    if (projectIndex === -1) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const project = projects[projectIndex];
    const holds = project.holds || [];

    // Check if already held
    if (holds.includes(packageName)) {
      return NextResponse.json({ success: true, holds, message: 'Package already on hold' });
    }

    // Add to holds
    const updatedHolds = [...holds, packageName];
    projects[projectIndex] = { ...project, holds: updatedHolds };

    saveConfig({ projects, categories: getCategories() });

    return NextResponse.json({ success: true, holds: updatedHolds });
  } catch (error) {
    console.error('Error adding hold:', error);
    return NextResponse.json({ error: 'Failed to add hold' }, { status: 500 });
  }
}

// Remove a package from holds
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body: HoldRequest = await request.json();
    const { package: packageName } = body;

    if (!packageName) {
      return NextResponse.json({ error: 'Package name is required' }, { status: 400 });
    }

    const projects = getProjects();
    const projectIndex = projects.findIndex(p => p.id === id);

    if (projectIndex === -1) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const project = projects[projectIndex];
    const holds = project.holds || [];

    // Remove from holds
    const updatedHolds = holds.filter(h => h !== packageName);
    projects[projectIndex] = { ...project, holds: updatedHolds.length > 0 ? updatedHolds : undefined };

    saveConfig({ projects, categories: getCategories() });

    return NextResponse.json({ success: true, holds: updatedHolds });
  } catch (error) {
    console.error('Error removing hold:', error);
    return NextResponse.json({ error: 'Failed to remove hold' }, { status: 500 });
  }
}

// Get holds for a project
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const projects = getProjects();
    const project = projects.find(p => p.id === id);

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json({ holds: project.holds || [] });
  } catch (error) {
    console.error('Error getting holds:', error);
    return NextResponse.json({ error: 'Failed to get holds' }, { status: 500 });
  }
}
