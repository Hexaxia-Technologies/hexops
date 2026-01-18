'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';

interface InfoSectionProps {
  projectId: string;
  projectPath: string;
}

interface ProjectInfo {
  name: string;
  version: string;
  description?: string;
  scripts: Record<string, string>;
  nodeVersion?: string;
  packageManager?: string;
}

export function InfoSection({ projectId, projectPath }: InfoSectionProps) {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchInfo = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/info`);
        if (!res.ok) throw new Error('Failed to fetch project info');
        const data = await res.json();
        setInfo(data);
        setError(null);
      } catch (err) {
        setError('Could not load project info');
        console.error('Failed to fetch project info:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchInfo();
  }, [projectId]);

  if (loading) {
    return <div className="text-zinc-500 text-sm">Loading project info...</div>;
  }

  if (error || !info) {
    return <div className="text-red-400 text-sm">{error || 'No project info available'}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Basic Info */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-zinc-500 block mb-1">Package Name</label>
          <span className="text-sm text-zinc-200">{info.name}</span>
        </div>
        <div>
          <label className="text-xs text-zinc-500 block mb-1">Version</label>
          <span className="text-sm text-zinc-200">{info.version}</span>
        </div>
        {info.nodeVersion && (
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Node Version</label>
            <span className="text-sm text-zinc-200">{info.nodeVersion}</span>
          </div>
        )}
        {info.packageManager && (
          <div>
            <label className="text-xs text-zinc-500 block mb-1">Package Manager</label>
            <span className="text-sm text-zinc-200">{info.packageManager}</span>
          </div>
        )}
      </div>

      {info.description && (
        <div>
          <label className="text-xs text-zinc-500 block mb-1">Description</label>
          <p className="text-sm text-zinc-300">{info.description}</p>
        </div>
      )}

      {/* Scripts */}
      <div>
        <label className="text-xs text-zinc-500 block mb-2">Available Scripts</label>
        <div className="flex flex-wrap gap-2">
          {Object.keys(info.scripts).map((script) => (
            <Badge
              key={script}
              variant="outline"
              className="text-xs font-mono border-zinc-700 text-zinc-400"
            >
              {script}
            </Badge>
          ))}
        </div>
      </div>

      {/* Path */}
      <div>
        <label className="text-xs text-zinc-500 block mb-1">Project Path</label>
        <code className="text-xs text-zinc-400 bg-zinc-900 px-2 py-1 rounded block overflow-x-auto">
          {projectPath}
        </code>
      </div>
    </div>
  );
}
