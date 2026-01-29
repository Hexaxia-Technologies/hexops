'use client';

import { ReactNode, useState, useEffect } from 'react';
import { SidebarProvider, useSidebar } from '@/contexts/sidebar-context';
import { Sidebar } from '@/components/sidebar';
import { AddProjectDialog } from '@/components/add-project-dialog';
import { ShellPanel } from '@/components/shell-panel';
import { X } from 'lucide-react';

interface ProvidersProps {
  children: ReactNode;
}

function AppShell({ children }: { children: ReactNode }) {
  const [showAddProject, setShowAddProject] = useState(false);
  const [showShell, setShowShell] = useState(false);
  const [projectsRoot, setProjectsRoot] = useState<string>('');
  const { categories, refresh } = useSidebar();

  // Fetch projectsRoot for shell default directory
  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(data => setProjectsRoot(data.projectsRoot || ''))
      .catch(() => {});
  }, []);

  return (
    <div className="flex h-screen bg-zinc-950">
      <Sidebar
        onAddProject={() => setShowAddProject(true)}
        onOpenShell={() => setShowShell(true)}
      />
      {children}

      {/* Shell Panel */}
      {showShell && projectsRoot && (
        <div className="w-[500px] h-full border-l border-zinc-800 flex flex-col bg-zinc-950 flex-shrink-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 flex-shrink-0">
            <span className="text-sm font-medium text-zinc-300">Shell</span>
            <button
              onClick={() => setShowShell(false)}
              className="p-1 hover:bg-zinc-800 rounded transition-colors"
            >
              <X className="h-4 w-4 text-zinc-500" />
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <ShellPanel cwd={projectsRoot} label="Shell" />
          </div>
        </div>
      )}

      <AddProjectDialog
        open={showAddProject}
        onOpenChange={setShowAddProject}
        onSuccess={refresh}
        categories={categories}
      />
    </div>
  );
}

export function Providers({ children }: ProvidersProps) {
  return (
    <SidebarProvider>
      <AppShell>
        {children}
      </AppShell>
    </SidebarProvider>
  );
}
