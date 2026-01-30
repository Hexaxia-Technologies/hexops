import { NextRequest, NextResponse } from 'next/server';
import { getProjects, getCategories } from '@/lib/config';
import { readPatchState } from '@/lib/patch-storage';
import { scanProject, buildPriorityQueue } from '@/lib/patch-scanner';
import type { ProjectPatchCache } from '@/lib/types';

export async function GET(_request: NextRequest) {
  try {
    const allProjects = getProjects();
    const categories = getCategories();
    const state = readPatchState();

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

    // Scan projects sequentially to avoid timeout issues when cache misses occur
    // (parallel scanning overwhelms the system with too many npm/pnpm commands)
    const caches: (ProjectPatchCache | null)[] = [];
    for (const project of projects) {
      try {
        const cache = await scanProject(project);
        caches.push(cache);
      } catch (err) {
        console.error(`Failed to scan project ${project.id}:`, err);
        caches.push(null);
      }
    }

    // Filter out failed scans
    const validCaches = caches.filter((c): c is ProjectPatchCache => c !== null);

    // Build priority queue with project names and holds
    const { queue, summary } = buildPriorityQueue(validCaches, projectMap, holdsMap);

    return NextResponse.json({
      queue,
      summary,
      lastScan: state.lastFullScan,
      projectCount: projects.length,
      categories,
      projectCategories,  // Map projectId -> category for filtering
      projectNames: projectMap,  // Map projectId -> name for display
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    console.error('Error fetching patches:', error);
    return NextResponse.json(
      { error: 'Failed to fetch patch data' },
      { status: 500 }
    );
  }
}
