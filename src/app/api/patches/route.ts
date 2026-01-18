import { NextResponse } from 'next/server';
import { getProjects } from '@/lib/config';
import { readPatchState } from '@/lib/patch-storage';
import { scanProject, buildPriorityQueue } from '@/lib/patch-scanner';

export async function GET() {
  try {
    const projects = getProjects();
    const state = readPatchState();

    // Scan all projects (uses cache if valid)
    const caches = await Promise.all(
      projects.map(project => scanProject(project))
    );

    // Build priority queue
    const { queue, summary } = buildPriorityQueue(caches);

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
