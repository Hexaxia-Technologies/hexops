'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Sidebar } from '@/components/sidebar';
import { ProjectList } from '@/components/project-list';
import { RightSidebar } from '@/components/right-sidebar';
import { Button } from '@/components/ui/button';
import type { Project } from '@/lib/types';

type RightPanel = { type: 'logs'; projectId: string } | null;

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

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

  useEffect(() => {
    fetchProjects();
    const interval = setInterval(fetchProjects, 5000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  const handleStart = async (id: string) => {
    const project = projects.find(p => p.id === id);
    try {
      const res = await fetch(`/api/projects/${id}/start`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Starting ${project?.name || id}`, {
          description: `Port ${project?.port}`,
        });
      } else {
        toast.error(`Failed to start ${project?.name || id}`, {
          description: data.error,
        });
      }
      setTimeout(fetchProjects, 1000);
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
        // Close right panel if we stopped the project being viewed
        if (rightPanel?.projectId === id) {
          setRightPanel(null);
        }
      } else {
        toast.error(`Failed to stop ${project?.name || id}`, {
          description: data.error,
        });
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
    setRightPanel({ type: 'logs', projectId: id });
  };

  const handleCloseRightPanel = () => {
    setRightPanel(null);
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

  // Filter projects based on selected category
  const filteredProjects = projects.filter((project) => {
    if (selectedCategory === null) return true;
    if (selectedCategory === 'running') return project.status === 'running';
    if (selectedCategory === 'stopped') return project.status === 'stopped';
    return project.category === selectedCategory;
  });

  // Calculate counts
  const projectCounts = categories.reduce((acc, cat) => {
    acc[cat] = projects.filter((p) => p.category === cat).length;
    return acc;
  }, {} as Record<string, number>);

  const runningCount = projects.filter((p) => p.status === 'running').length;

  const rightPanelProject = rightPanel
    ? projects.find((p) => p.id === rightPanel.projectId)
    : null;

  if (isLoading) {
    return (
      <div className="flex h-screen bg-zinc-950 items-center justify-center">
        <div className="text-zinc-500">Loading projects...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-zinc-950">
      {/* Left Sidebar - Navigation */}
      <Sidebar
        categories={categories}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
        projectCounts={projectCounts}
        runningCount={runningCount}
        totalCount={projects.length}
      />

      {/* Main Content - Project List */}
      <main className="flex-1 flex flex-col overflow-hidden">
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
          <ProjectList
            projects={filteredProjects}
            selectedId={selectedProjectId}
            onSelect={handleSelect}
            onStart={handleStart}
            onStop={handleStop}
            onViewLogs={handleViewLogs}
            onClearCache={handleClearCache}
            onDeleteLock={handleDeleteLock}
          />
        </div>
      </main>

      {/* Right Sidebar - Panels */}
      <RightSidebar
        panel={rightPanel?.type || null}
        onClose={handleCloseRightPanel}
        projectId={rightPanel?.projectId}
        projectName={rightPanelProject?.name}
      />
    </div>
  );
}
