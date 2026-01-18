import { NextRequest, NextResponse } from 'next/server';
import { getProjects } from '@/lib/config';
import { scanProject, buildPriorityQueue } from '@/lib/patch-scanner';
import { writePatchState, readPatchState } from '@/lib/patch-storage';
import type { ProjectPatchCache } from '@/lib/types';

export async function POST(_request: NextRequest) {
  try {
    const projects = getProjects();

    // Force refresh all projects
    const caches = await Promise.all(
      projects.map(async project => {
        try {
          return await scanProject(project, true);
        } catch (err) {
          console.error(`Failed to scan project ${project.id}:`, err);
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

    // Build priority queue
    const { queue, summary } = buildPriorityQueue(validCaches);

    return NextResponse.json({
      success: true,
      queue,
      summary,
      lastScan: state.lastFullScan,
      projectCount: projects.length,
      scannedCount: validCaches.length,
    });
  } catch (error) {
    console.error('Error scanning patches:', error);
    return NextResponse.json(
      { error: 'Failed to scan patches' },
      { status: 500 }
    );
  }
}
