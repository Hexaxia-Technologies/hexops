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

    // Scan all projects (uses cache if valid)
    const caches = await Promise.all(
      projects.map(async project => {
        try {
          return await scanProject(project);
        } catch (err) {
          console.error(`Failed to scan project ${project.id}:`, err);
          return null;
        }
      })
    );

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
