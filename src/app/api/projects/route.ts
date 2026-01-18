import { NextResponse } from 'next/server';
import { getProjects, getCategories } from '@/lib/config';
import { checkPorts } from '@/lib/port-checker';
import type { Project } from '@/lib/types';

export async function GET() {
  try {
    const projectConfigs = getProjects();
    const categories = getCategories();

    // Check all ports in parallel
    const ports = projectConfigs.map((p) => p.port);
    const portStatus = await checkPorts(ports);

    // Combine config with status
    const projects: Project[] = projectConfigs.map((config) => ({
      ...config,
      status: portStatus.get(config.port) ? 'running' : 'stopped',
    }));

    return NextResponse.json({
      projects,
      categories,
    });
  } catch (error) {
    console.error('Error fetching projects:', error);
    return NextResponse.json(
      { error: 'Failed to fetch projects' },
      { status: 500 }
    );
  }
}
