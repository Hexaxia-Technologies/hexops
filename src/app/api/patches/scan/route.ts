import { NextRequest, NextResponse } from 'next/server';
import { getProjects, getCategories } from '@/lib/config';
import { scanProject, buildPriorityQueue } from '@/lib/patch-scanner';
import { writePatchState, readPatchState } from '@/lib/patch-storage';
import type { ProjectPatchCache } from '@/lib/types';

export async function POST(_request: NextRequest) {
  try {
    const allProjects = getProjects();
    const categories = getCategories();
    const failedProjects: string[] = [];

    // All projects can be scanned and patched (hexops works fine in dev mode with hot reload)
    const projects = allProjects;

    // Build project ID -> name mapping
    const projectMap: Record<string, string> = {};
    const projectCategories: Record<string, string> = {};
    for (const project of projects) {
      projectMap[project.id] = project.name;
      projectCategories[project.id] = project.category;
    }

    // Force refresh all projects
    const caches = await Promise.all(
      projects.map(async project => {
        try {
          return await scanProject(project, true);
        } catch (err) {
          console.error(`Failed to scan project ${project.id}:`, err);
          failedProjects.push(project.id);
          return null;
        }
      })
    );

    // Filter out failed scans
    const validCaches = caches.filter((c): c is ProjectPatchCache => c !== null);

    // Update last scan time
    const state = readPatchState();
    state.lastFullScan = new Date().toISOString();
    writePatchState(state);

    // Build priority queue with project names
    const { queue, summary } = buildPriorityQueue(validCaches, projectMap);

    return NextResponse.json({
      success: failedProjects.length === 0,
      queue,
      summary,
      lastScan: state.lastFullScan,
      projectCount: projects.length,
      categories,
      projectCategories,
      scannedCount: validCaches.length,
      failedProjects,
    });
  } catch (error) {
    console.error('Error scanning patches:', error);
    return NextResponse.json(
      { error: 'Failed to scan patches' },
      { status: 500 }
    );
  }
}
