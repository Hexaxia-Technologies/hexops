import { NextResponse } from 'next/server';
import { getProjects, getCategories } from '@/lib/config';
import { checkPorts } from '@/lib/port-checker';
import { getExtendedStatusBatch } from '@/lib/extended-status';
import type { Project } from '@/lib/types';

export async function GET() {
  try {
    const projectConfigs = getProjects();
    const categories = getCategories();

    // Check all ports in parallel
    const ports = projectConfigs.map((p) => p.port);
    const portStatus = await checkPorts(ports);

    // Build list for extended status fetch
    const projectsWithStatus = projectConfigs.map((config) => ({
      config,
      isRunning: portStatus.get(config.port) ?? false,
    }));

    // Fetch extended status for all projects in parallel (includes package checks)
    const extendedStatus = await getExtendedStatusBatch(projectsWithStatus, true);

    // Combine config with status and extended info
    const projects: Project[] = projectConfigs.map((config) => ({
      ...config,
      status: portStatus.get(config.port) ? 'running' : 'stopped',
      extended: extendedStatus.get(config.id),
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
