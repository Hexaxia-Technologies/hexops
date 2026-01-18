import { NextRequest, NextResponse } from 'next/server';
import { getProjects } from '@/lib/config';
import { readPatchState } from '@/lib/patch-storage';
import { scanProject, buildPriorityQueue } from '@/lib/patch-scanner';
import type { ProjectPatchCache } from '@/lib/types';

export async function GET(_request: NextRequest) {
  try {
    const projects = getProjects();
    const state = readPatchState();

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

    // Build priority queue
    const { queue, summary } = buildPriorityQueue(validCaches);

    return NextResponse.json({
      queue,
      summary,
      lastScan: state.lastFullScan,
      projectCount: projects.length,
    });
  } catch (error) {
    console.error('Error fetching patches:', error);
    return NextResponse.json(
      { error: 'Failed to fetch patch data' },
      { status: 500 }
    );
  }
}
