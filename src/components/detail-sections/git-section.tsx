'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, GitBranch, GitCommit, AlertCircle } from 'lucide-react';

interface GitSectionProps {
  projectId: string;
  projectPath: string;
}

interface GitInfo {
  branch: string;
  lastCommit: {
    hash: string;
    message: string;
    author: string;
    date: string;
  };
  isDirty: boolean;
  uncommittedCount: number;
  untrackedCount: number;
}

export function GitSection({ projectId }: GitSectionProps) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGitInfo = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/git`);
      if (!res.ok) throw new Error('Failed to fetch git info');
      const data = await res.json();
      setInfo(data);
      setError(null);
    } catch (err) {
      setError('Could not load git info');
      console.error('Failed to fetch git info:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGitInfo();
  }, [projectId]);

  if (loading) {
    return <div className="text-zinc-500 text-sm">Loading git info...</div>;
  }

  if (error) {
    return (
      <div className="text-zinc-500 text-sm flex items-center gap-2">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    );
  }

  if (!info) {
    return <div className="text-zinc-500 text-sm">Not a git repository</div>;
  }

  return (
    <div className="space-y-4">
      {/* Branch and Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-200">{info.branch}</span>
          </div>

          {info.isDirty && (
            <Badge variant="outline" className="text-xs border-yellow-500/50 text-yellow-400">
              Uncommitted changes
            </Badge>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-zinc-400"
          onClick={fetchGitInfo}
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Refresh
        </Button>
      </div>

      {/* Change counts */}
      {(info.uncommittedCount > 0 || info.untrackedCount > 0) && (
        <div className="flex gap-4 text-xs">
          {info.uncommittedCount > 0 && (
            <span className="text-yellow-400">
              {info.uncommittedCount} modified file{info.uncommittedCount !== 1 ? 's' : ''}
            </span>
          )}
          {info.untrackedCount > 0 && (
            <span className="text-zinc-500">
              {info.untrackedCount} untracked file{info.untrackedCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}

      {/* Last Commit */}
      <div className="bg-zinc-900 rounded-md p-3">
        <div className="flex items-start gap-2">
          <GitCommit className="h-4 w-4 text-zinc-500 mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-zinc-200 truncate">{info.lastCommit.message}</p>
            <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
              <span className="font-mono">{info.lastCommit.hash}</span>
              <span>by {info.lastCommit.author}</span>
              <span>{new Date(info.lastCommit.date).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
