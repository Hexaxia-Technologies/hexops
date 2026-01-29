'use client';

import { ReactNode, useState } from 'react';
import { SidebarProvider, useSidebar } from '@/contexts/sidebar-context';
import { Sidebar } from '@/components/sidebar';
import { AddProjectDialog } from '@/components/add-project-dialog';

interface ProvidersProps {
  children: ReactNode;
}

function AppShell({ children }: { children: ReactNode }) {
  const [showAddProject, setShowAddProject] = useState(false);
  const { categories, refresh } = useSidebar();

  return (
    <div className="flex h-screen bg-zinc-950">
      <Sidebar onAddProject={() => setShowAddProject(true)} />
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

export function Providers({ children }: ProvidersProps) {
  return (
    <SidebarProvider>
      <AppShell>
        {children}
      </AppShell>
    </SidebarProvider>
  );
}
