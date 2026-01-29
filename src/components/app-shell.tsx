'use client';

import { ReactNode, useState } from 'react';
import { Sidebar } from '@/components/sidebar';
import { AddProjectDialog } from '@/components/add-project-dialog';
import { useSidebar } from '@/contexts/sidebar-context';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [showAddProject, setShowAddProject] = useState(false);
  const { categories, refresh } = useSidebar();

  return (
    <div className="flex h-screen bg-zinc-950">
      <Sidebar
        onAddProject={() => setShowAddProject(true)}
      />
      {children}
      <AddProjectDialog
        open={showAddProject}
        onOpenChange={setShowAddProject}
        onSuccess={refresh}
        categories={categories}
      />
    </div>
  );
}
