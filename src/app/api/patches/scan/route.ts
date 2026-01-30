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

    // Build project ID -> name mapping and holds map
    const projectMap: Record<string, string> = {};
    const projectCategories: Record<string, string> = {};
    const holdsMap: Record<string, string[]> = {};
    for (const project of projects) {
      projectMap[project.id] = project.name;
      projectCategories[project.id] = project.category;
      if (project.holds && project.holds.length > 0) {
        holdsMap[project.id] = project.holds;
      }
    }

    // Scan projects sequentially to avoid timeout issues
    // (parallel scanning overwhelms the system with too many npm/pnpm commands)
    const caches: (ProjectPatchCache | null)[] = [];
    for (const project of projects) {
      try {
        const cache = await scanProject(project, true);
        caches.push(cache);
      } catch (err) {
        console.error(`Failed to scan project ${project.id}:`, err);
        failedProjects.push(project.id);
        caches.push(null);
      }
    }

    // Filter out failed scans
    const validCaches = caches.filter((c): c is ProjectPatchCache => c !== null);

    // Update last scan time
    const state = readPatchState();
    state.lastFullScan = new Date().toISOString();
    writePatchState(state);

    // Build priority queue with project names and holds
    const { queue, summary } = buildPriorityQueue(validCaches, projectMap, holdsMap);

    return NextResponse.json({
      success: failedProjects.length === 0,
      queue,
      summary,
      lastScan: state.lastFullScan,
      projectCount: projects.length,
      categories,
      projectCategories,
      projectNames: projectMap,  // Map projectId -> name for display
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
