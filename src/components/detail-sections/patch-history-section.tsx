'use client';

import { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, Package, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PatchHistoryEntry {
  id: string;
  timestamp: string;
  projectId: string;
  projectName?: string;
  package: string;
  fromVersion: string;
  toVersion: string;
  updateType: string;
  trigger: string;
  success: boolean;
  error?: string;
}

interface PatchHistorySectionProps {
  projectId: string;
}

export function PatchHistorySection({ projectId }: PatchHistorySectionProps) {
  const [history, setHistory] = useState<PatchHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const res = await fetch(`/api/patches/history?projectId=${projectId}&limit=10`);
        if (!res.ok) throw new Error('Failed to fetch');
        const data = await res.json();
        setHistory(data.updates || []);
        setTotal(data.total || 0);
      } catch (error) {
        console.error('Failed to fetch patch history:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [projectId]);

  if (loading) {
    return (
      <div className="p-4 text-center text-zinc-500 text-sm">
        Loading history...
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="p-6 text-center">
        <div className="w-10 h-10 rounded-full bg-zinc-800/50 flex items-center justify-center mx-auto mb-3">
          <Package className="h-4 w-4 text-zinc-600" />
        </div>
        <p className="text-sm text-zinc-500">No patch history yet</p>
        <p className="text-xs text-zinc-600 mt-1">
          Updates applied via the Patches page will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-zinc-800">
      {history.map((entry) => (
        <div
          key={entry.id}
          className={cn(
            'p-4 flex items-start gap-3',
            entry.success ? 'bg-green-500/5' : 'bg-red-500/5'
          )}
        >
          {entry.success ? (
            <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
          ) : (
            <XCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
          )}

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-zinc-200 truncate">
                {entry.package}
              </span>
              <span className={cn(
                'text-[10px] px-1.5 py-0.5 rounded uppercase',
                entry.updateType === 'major' ? 'bg-red-500/20 text-red-400' :
                entry.updateType === 'minor' ? 'bg-yellow-500/20 text-yellow-400' :
                'bg-blue-500/20 text-blue-400'
              )}>
                {entry.updateType}
              </span>
            </div>

            <div className="text-xs text-zinc-500 mt-1">
              {entry.fromVersion} → {entry.toVersion}
            </div>

            {entry.error && (
              <div className="text-xs text-red-400 mt-1 truncate">
                {entry.error}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 text-[10px] text-zinc-600 flex-shrink-0">
            <Clock className="h-3 w-3" />
            {formatRelativeTime(entry.timestamp)}
          </div>
        </div>
      ))}

      {total > history.length && (
        <div className="p-3 text-center text-xs text-zinc-500">
          Showing {history.length} of {total} updates
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
