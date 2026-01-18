'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { X, ChevronLeft } from 'lucide-react';
import type { LogEntry } from '@/lib/types';

type PanelType = 'logs' | 'details' | null;

interface RightSidebarProps {
  // Current panel type
  panel: PanelType;
  onClose: () => void;

  // Log viewer props (when panel === 'logs')
  projectId?: string;
  projectName?: string;
}

export function RightSidebar({
  panel,
  onClose,
  projectId,
  projectName,
}: RightSidebarProps) {
  return (
    <aside className="w-[400px] flex-shrink-0 border-l border-zinc-800 bg-zinc-950 flex flex-col overflow-hidden">
      {panel === 'logs' && projectId ? (
        <LogPanel
          projectId={projectId}
          projectName={projectName || projectId}
          onClose={onClose}
        />
      ) : (
        <EmptyState />
      )}
      {/* Future panels can be added here */}
      {/* {panel === 'details' && <DetailsPanel ... />} */}
    </aside>
  );
}

// Empty state when no panel is active
function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
      <div className="w-12 h-12 rounded-full bg-zinc-800/50 flex items-center justify-center mb-4">
        <span className="text-2xl text-zinc-600">📋</span>
      </div>
      <h3 className="text-sm font-medium text-zinc-400 mb-1">No panel open</h3>
      <p className="text-xs text-zinc-600 max-w-[200px]">
        Click "View Logs" on a running project to see live output here
      </p>
    </div>
  );
}

// Log Panel Component
interface LogPanelProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

function LogPanel({ projectId, projectName, onClose }: LogPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/logs`);
        const data = await res.json();
        setLogs(data.logs || []);
      } catch (error) {
        console.error('Failed to fetch logs:', error);
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);

    return () => clearInterval(interval);
  }, [projectId]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-100"
            onClick={onClose}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="font-medium text-zinc-100 text-sm">{projectName}</h2>
            <p className="text-xs text-zinc-500">Live Logs</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className={`text-xs h-7 ${autoScroll ? 'text-purple-400' : 'text-zinc-500'}`}
            onClick={() => setAutoScroll(!autoScroll)}
          >
            {autoScroll ? 'Auto-scroll' : 'Manual'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-100"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Log content */}
      <div className="flex-1 overflow-auto p-4" ref={scrollRef}>
        <div className="font-mono text-xs space-y-1">
          {logs.length === 0 ? (
            <p className="text-zinc-600">No logs yet...</p>
          ) : (
            logs.map((log, i) => (
              <div
                key={i}
                className={log.type === 'stderr' ? 'text-red-400' : 'text-zinc-300'}
              >
                <span className="text-zinc-600 mr-2">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="whitespace-pre-wrap">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
