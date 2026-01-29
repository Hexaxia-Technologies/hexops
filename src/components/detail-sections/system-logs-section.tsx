'use client';

import { LogViewer } from '@/components/log-viewer';

interface SystemLogsSectionProps {
  projectId: string;
}

export function SystemLogsSection({ projectId }: SystemLogsSectionProps) {
  return (
    <div className="h-[400px] -mx-4 -mb-4">
      <LogViewer
        projectId={projectId}
        showProjectFilter={false}
        className="h-full"
      />
    </div>
  );
}
