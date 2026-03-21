import { NextRequest } from 'next/server';
import { getProjects, getCategories } from '@/lib/config';
import { readPatchState, readProjectCache } from '@/lib/patch-storage';
import { scanProject, buildPriorityQueue } from '@/lib/patch-scanner';
import type { ProjectPatchCache } from '@/lib/types';

export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

function sseEvent(data: object): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: NextRequest) {
  const force = request.nextUrl.searchParams.get('force') === '1';

  const allProjects = getProjects();
  const categories = getCategories();
  const state = readPatchState();

  const projectMap: Record<string, string> = {};
  const projectCategories: Record<string, string> = {};
  const holdsMap: Record<string, string[]> = {};
  for (const project of allProjects) {
    projectMap[project.id] = project.name;
    projectCategories[project.id] = project.category;
    if (project.holds && project.holds.length > 0) {
      holdsMap[project.id] = project.holds;
    }
  }

  // Fast path: if all caches are valid and not forcing, skip SSE and return directly
  if (!force) {
    const allCached = allProjects.every(p => readProjectCache(p.id) !== null);
    if (allCached) {
      const caches = allProjects
        .map(p => readProjectCache(p.id))
        .filter((c): c is ProjectPatchCache => c !== null);

      const { queue, summary } = buildPriorityQueue(caches, projectMap, holdsMap);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(sseEvent({
            type: 'complete',
            queue,
            summary,
            lastScan: state.lastFullScan,
            projectCount: allProjects.length,
            categories,
            projectCategories,
            projectNames: projectMap,
          }));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-store',
          'Connection': 'keep-alive',
        },
      });
    }
  }

  // Streaming path: scan projects one by one, emit progress events
  const stream = new ReadableStream({
    async start(controller) {
      const caches: (ProjectPatchCache | null)[] = [];
      const total = allProjects.length;

      for (let i = 0; i < allProjects.length; i++) {
        // Bail if client disconnected
        if (request.signal.aborted) {
          controller.close();
          return;
        }

        const project = allProjects[i];

        try {
          const cache = await scanProject(project, force);
          caches.push(cache);
        } catch (err) {
          console.error(`Failed to scan project ${project.id}:`, err);
          caches.push(null);
        }

        controller.enqueue(sseEvent({
          type: 'progress',
          projectId: project.id,
          projectName: project.name,
          scanned: i + 1,
          total,
        }));
      }

      const validCaches = caches.filter((c): c is ProjectPatchCache => c !== null);
      const { queue, summary } = buildPriorityQueue(validCaches, projectMap, holdsMap);

      controller.enqueue(sseEvent({
        type: 'complete',
        queue,
        summary,
        lastScan: state.lastFullScan,
        projectCount: allProjects.length,
        categories,
        projectCategories,
        projectNames: projectMap,
      }));

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    },
  });
}
