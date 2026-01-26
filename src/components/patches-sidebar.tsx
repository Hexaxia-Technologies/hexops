'use client';

import { CheckCircle2, XCircle, Loader2, Package } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface UpdateResult {
  projectId: string;
  projectName: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  success: boolean;
  error?: string;
  timestamp: Date;
}

export interface UpdateStatus {
  isUpdating: boolean;
  currentProject?: string;
  currentPackage?: string;
  progress: number;  // 0-100
  total: number;
}

interface PatchesSidebarProps {
  updateStatus: UpdateStatus | null;
  recentUpdates: UpdateResult[];
}

export function PatchesSidebar({
  updateStatus,
  recentUpdates,
}: PatchesSidebarProps) {
  const hasActivity = updateStatus?.isUpdating || recentUpdates.length > 0;

  return (
    <aside className="w-[320px] flex-shrink-0 border-l border-zinc-800 bg-zinc-950 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
        <h3 className="text-sm font-medium text-zinc-300">Update Status</h3>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {!hasActivity ? (
          <EmptyState />
        ) : (
          <div className="p-4 space-y-4">
            {/* Current update progress */}
            {updateStatus?.isUpdating && (
              <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
                <div className="flex items-center gap-2 mb-3">
                  <Loader2 className="h-4 w-4 text-purple-400 animate-spin" />
                  <span className="text-sm font-medium text-zinc-200">Updating...</span>
                </div>

                <div className="space-y-2">
                  {updateStatus.currentProject && (
                    <div className="text-xs text-zinc-400">
                      Project: <span className="text-zinc-300">{updateStatus.currentProject}</span>
                    </div>
                  )}
                  {updateStatus.currentPackage && (
                    <div className="text-xs text-zinc-400">
                      Package: <span className="text-zinc-300 font-mono">{updateStatus.currentPackage}</span>
                    </div>
                  )}

                  {/* Progress bar */}
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
                      <span>Progress</span>
                      <span>{updateStatus.progress} / {updateStatus.total}</span>
                    </div>
                    <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-500 transition-all duration-300"
                        style={{ width: `${(updateStatus.progress / updateStatus.total) * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Recent updates */}
            {recentUpdates.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-3">
                  Recent Updates
                </h4>
                <div className="space-y-2">
                  {recentUpdates.slice(0, 10).map((update, idx) => (
                    <UpdateResultItem key={idx} result={update} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
      <div className="w-12 h-12 rounded-full bg-zinc-800/50 flex items-center justify-center mb-4">
        <Package className="h-5 w-5 text-zinc-600" />
      </div>
      <h3 className="text-sm font-medium text-zinc-400 mb-1">No updates in progress</h3>
      <p className="text-xs text-zinc-600 max-w-[200px]">
        Select packages and click "Update Selected" to see progress here
      </p>
    </div>
  );
}

function UpdateResultItem({ result }: { result: UpdateResult }) {
  return (
    <div
      className={cn(
        'rounded-md p-3 border',
        result.success
          ? 'bg-green-500/5 border-green-500/20'
          : 'bg-red-500/5 border-red-500/20'
      )}
    >
      <div className="flex items-start gap-2">
        {result.success ? (
          <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
        ) : (
          <XCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-zinc-300 truncate">
              {result.packageName}
            </span>
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {result.projectName}
          </div>
          {result.fromVersion && result.toVersion && (
            <div className="text-xs text-zinc-600 mt-1">
              {result.fromVersion} → {result.toVersion}
            </div>
          )}
          {result.error && (
            <div className="text-xs text-red-400 mt-1 truncate">
              {result.error}
            </div>
          )}
        </div>
        <span className="text-[10px] text-zinc-600 flex-shrink-0">
          {result.timestamp.toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}
