import { NextResponse } from 'next/server';
import { getProjects, getCategories } from '@/lib/config';
import { checkPorts } from '@/lib/port-checker';

// Lightweight endpoint for sidebar data only - no extended status
export async function GET() {
  try {
    const projectConfigs = getProjects();
    const categories = getCategories();

    // Check all ports in parallel
    const ports = projectConfigs.map((p) => p.port);
    const portStatus = await checkPorts(ports);

    // Build minimal project list for sidebar
    const projects = projectConfigs.map((config) => ({
      id: config.id,
      name: config.name,
      category: config.category,
      status: portStatus.get(config.port) ? 'running' : 'stopped',
    }));

    return NextResponse.json({
      projects,
      categories,
    });
  } catch (error) {
    console.error('Error fetching sidebar data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch sidebar data' },
      { status: 500 }
    );
  }
}
