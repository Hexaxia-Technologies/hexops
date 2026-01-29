'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ProjectList } from '@/components/project-list';
import { ProjectDetail } from '@/components/project-detail';
import { SystemHealth } from '@/components/system-health';
import { Button } from '@/components/ui/button';
import type { Project } from '@/lib/types';

interface PatchStatus {
  patched: number;
  unpatched: number;
  heldPackages: number;
  total: number;
}

type ViewMode = 'list' | 'detail';

function HomeContent() {
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const selectedCategory: string | null = null; // Category filtering disabled for now
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [detailProjectId, setDetailProjectId] = useState<string | null>(null);
  const [patchStatus, setPatchStatus] = useState<PatchStatus | null>(null);

  // Handle ?project=id query param to deep link to project detail
  useEffect(() => {
    const projectId = searchParams.get('project');
    if (projectId) {
      setDetailProjectId(projectId);
      setViewMode('detail');
    }
  }, [searchParams]);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data.projects || []);
      setCategories(data.categories || []);
      setLastRefresh(new Date());
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchPatchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/patches');
      const data = await res.json();

      if (data.queue !== undefined && data.projectCount !== undefined) {
        const total = data.projectCount;

        // Group patches by project and count held packages
        const patchesByProject: Record<string, number> = {};
        let heldPackages = 0;

        for (const patch of data.queue) {
          if (!patchesByProject[patch.projectId]) {
            patchesByProject[patch.projectId] = 0;
          }
          patchesByProject[patch.projectId]++;

          // Count total held packages
          if (patch.isHeld === true) {
            heldPackages++;
          }
        }

        // Get unique project IDs from projectCategories (all scanned projects)
        const projectIds = data.projectCategories
          ? Object.keys(data.projectCategories)
          : Object.keys(patchesByProject);

        // Count projects by patch status (simple: patched or unpatched)
        let patched = 0;
        let unpatched = 0;

        for (const projectId of projectIds) {
          const patchCount = patchesByProject[projectId] || 0;
          if (patchCount === 0) {
            patched++;
          } else {
            unpatched++;
          }
        }

        setPatchStatus({ patched, unpatched, heldPackages, total });
      }
    } catch (error) {
      console.error('Failed to fetch patch status:', error);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
    fetchPatchStatus();
  }, [fetchProjects, fetchPatchStatus]);

  const handleStart = async (id: string) => {
    const project = projects.find(p => p.id === id);
    try {
      const res = await fetch(`/api/projects/${id}/start`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Starting ${project?.name || id}`, {
          description: `Port ${project?.port}`,
        });
      } else if (data.status === 'running' || data.error?.includes('already running')) {
        toast.success(`${project?.name || id} is already running`);
      } else {
        toast.error(`Failed to start ${project?.name || id}`, {
          description: data.error,
        });
        return;
      }

      // Poll until project is actually running (max 15 seconds)
      for (let i = 0; i < 15; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const statusRes = await fetch('/api/projects');
        const statusData = await statusRes.json();
        const updatedProject = statusData.projects?.find((p: Project) => p.id === id);
        if (updatedProject?.status === 'running') {
          setProjects(statusData.projects);
          setLastRefresh(new Date());
          return;
        }
      }
      fetchProjects();
    } catch (error) {
      toast.error(`Failed to start ${project?.name || id}`);
      console.error('Failed to start project:', error);
    }
  };

  const handleStop = async (id: string) => {
    const project = projects.find(p => p.id === id);
    try {
      const res = await fetch(`/api/projects/${id}/stop`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Stopped ${project?.name || id}`);
      } else {
        toast.error(`Failed to stop ${project?.name || id}`, {
          description: data.error,
        });
        return;
      }

      // Poll until project is actually stopped (max 10 seconds)
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const statusRes = await fetch('/api/projects');
        const statusData = await statusRes.json();
        const updatedProject = statusData.projects?.find((p: Project) => p.id === id);
        if (updatedProject?.status === 'stopped') {
          setProjects(statusData.projects);
          setLastRefresh(new Date());
          return;
        }
      }
      fetchProjects();
    } catch (error) {
      toast.error(`Failed to stop ${project?.name || id}`);
      console.error('Failed to stop project:', error);
    }
  };

  const handleSelect = (id: string) => {
    setSelectedProjectId(id);
  };

  const handleViewLogs = (id: string) => {
    setSelectedProjectId(id);
    // TODO: Integrate with global shell/panel system
  };

  const handleClearCache = async (id: string) => {
    const project = projects.find(p => p.id === id);
    try {
      const res = await fetch(`/api/projects/${id}/clear-cache`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast.success(data.message);
      } else {
        toast.error(`Failed to clear cache for ${project?.name || id}`, {
          description: data.error,
        });
      }
    } catch (error) {
      toast.error(`Failed to clear cache for ${project?.name || id}`);
      console.error('Failed to clear cache:', error);
    }
  };

  const handleDeleteLock = async (id: string) => {
    const project = projects.find(p => p.id === id);
    try {
      const res = await fetch(`/api/projects/${id}/delete-lock`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast.success(data.message);
      } else {
        toast.error(`Failed to delete lock for ${project?.name || id}`, {
          description: data.error,
        });
      }
    } catch (error) {
      toast.error(`Failed to delete lock for ${project?.name || id}`);
      console.error('Failed to delete lock:', error);
    }
  };

  const handleViewDetails = (id: string) => {
    setDetailProjectId(id);
    setViewMode('detail');
  };

  const handleBackToList = () => {
    setViewMode('list');
    setDetailProjectId(null);
  };

  // Filter projects based on selected category
  const filteredProjects = projects.filter((project) => {
    if (selectedCategory === null) return true;
    if (selectedCategory === 'running') return project.status === 'running';
    if (selectedCategory === 'stopped') return project.status === 'stopped';
    return project.category === selectedCategory;
  });

  // Get detail project - safely handle case where project might not exist
  const detailProject = viewMode === 'detail' && detailProjectId
    ? projects.find(p => p.id === detailProjectId)
    : null;

  if (isLoading) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-zinc-500">Loading projects...</div>
      </main>
    );
  }

  return (
    <>
      <main className="flex-1 flex flex-col overflow-hidden">
        {viewMode === 'list' ? (
          <>
            <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
              <div>
                <h2 className="text-lg font-medium text-zinc-100">
                  {selectedCategory === null
                    ? 'All Projects'
                    : selectedCategory === 'running'
                    ? 'Running Projects'
                    : selectedCategory === 'stopped'
                    ? 'Stopped Projects'
                    : selectedCategory}
                </h2>
                <p className="text-xs text-zinc-500">
                  {filteredProjects.length} project{filteredProjects.length !== 1 ? 's' : ''}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-xs text-zinc-600">
                  Last updated: {lastRefresh.toLocaleTimeString()}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  onClick={fetchProjects}
                >
                  Refresh
                </Button>
              </div>
            </header>

            <div className="flex-1 overflow-auto">
              <div className="px-6 pt-6">
                <SystemHealth patchStatus={patchStatus ?? undefined} />
              </div>
              <ProjectList
                projects={filteredProjects}
                selectedId={selectedProjectId}
                onSelect={handleSelect}
                onStart={handleStart}
                onStop={handleStop}
                onViewLogs={handleViewLogs}
                onViewDetails={handleViewDetails}
                onClearCache={handleClearCache}
                onDeleteLock={handleDeleteLock}
              />
            </div>
          </>
        ) : detailProject ? (
          <ProjectDetail
            project={detailProject}
            onBack={handleBackToList}
            onStart={handleStart}
            onStop={handleStop}
            onClearCache={handleClearCache}
            onDeleteLock={handleDeleteLock}
            onRefresh={fetchProjects}
            categories={categories}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-zinc-500">Loading project details...</div>
          </div>
        )}
      </main>
    </>
  );
}

export default function Home() {
  return (
    <Suspense fallback={
      <main className="flex-1 flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </main>
    }>
      <HomeContent />
    </Suspense>
  );
}
