'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { X, Terminal, Package, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LogEntry } from '@/lib/types';
import { ShellPanel as ShellPanelContent } from './shell-panel';

// Panel types
export type PanelType = 'logs' | 'package-health' | 'shell';

export interface LogsPanel {
  type: 'logs';
  projectId: string;
  projectName: string;
}

export interface PackageHealthPanel {
  type: 'package-health';
  projectId: string;
  projectName: string;
  subType: 'outdated' | 'audit';
  rawOutput: string;
  title: string;
}

export interface ShellPanel {
  type: 'shell';
  cwd: string;
  label: string;
}

export type Panel = LogsPanel | PackageHealthPanel | ShellPanel;

interface RightSidebarProps {
  panels: Panel[];
  activePanel: PanelType | null;
  onActivate: (type: PanelType) => void;
  onClose: (type: PanelType) => void;
  onCloseAll: () => void;
}

export function RightSidebar({
  panels,
  activePanel,
  onActivate,
  onClose,
  onCloseAll,
}: RightSidebarProps) {
  // Find active panel data
  const activePanelData = panels.find(p => p.type === activePanel);

  if (panels.length === 0) {
    return (
      <aside className="w-[400px] flex-shrink-0 border-l border-zinc-800 bg-zinc-950 flex flex-col overflow-hidden">
        <EmptyState />
      </aside>
    );
  }

  return (
    <aside className="w-[400px] flex-shrink-0 border-l border-zinc-800 bg-zinc-950 flex flex-col overflow-hidden">
      {/* Tab Bar */}
      <div className="flex items-center border-b border-zinc-800 bg-zinc-900/50">
        <div className="flex-1 flex">
          {panels.map((panel) => (
            <div
              key={panel.type}
              role="tab"
              tabIndex={0}
              onClick={() => onActivate(panel.type)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onActivate(panel.type);
                }
              }}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-r border-zinc-800 transition-colors cursor-pointer',
                activePanel === panel.type
                  ? 'bg-zinc-950 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900'
              )}
            >
              {panel.type === 'logs' ? (
                <Terminal className="h-3.5 w-3.5" />
              ) : panel.type === 'shell' ? (
                <TerminalSquare className="h-3.5 w-3.5" />
              ) : (
                <Package className="h-3.5 w-3.5" />
              )}
              <span>
                {panel.type === 'logs' ? 'Logs' :
                 panel.type === 'shell' ? 'Shell' :
                 (panel as PackageHealthPanel).subType === 'outdated' ? 'Updates' : 'Audit'}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(panel.type);
                }}
                className="ml-1 p-0.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        {panels.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-full px-3 text-xs text-zinc-500 hover:text-zinc-300 rounded-none"
            onClick={onCloseAll}
          >
            Close All
          </Button>
        )}
      </div>

      {/* Panel Content */}
      {activePanelData?.type === 'logs' && (
        <LogPanelContent
          projectId={activePanelData.projectId}
          projectName={activePanelData.projectName}
        />
      )}
      {activePanelData?.type === 'package-health' && (
        <PackageHealthPanelContent
          panel={activePanelData as PackageHealthPanel}
        />
      )}
      {activePanelData?.type === 'shell' && (
        <ShellPanelContent
          cwd={(activePanelData as ShellPanel).cwd}
          label={(activePanelData as ShellPanel).label}
        />
      )}
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
        Click "View Logs" on a running project or run package health checks to see output here
      </p>
    </div>
  );
}

// Log Panel Content
interface LogPanelContentProps {
  projectId: string;
  projectName: string;
}

function LogPanelContent({ projectId, projectName }: LogPanelContentProps) {
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
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/50 flex-shrink-0 bg-zinc-900/30">
        <div className="text-xs text-zinc-500">
          <span className="text-zinc-300">{projectName}</span> — Live Logs
        </div>
        <Button
          variant="ghost"
          size="sm"
          className={cn('text-xs h-6 px-2', autoScroll ? 'text-purple-400' : 'text-zinc-500')}
          onClick={() => setAutoScroll(!autoScroll)}
        >
          {autoScroll ? 'Auto-scroll' : 'Manual'}
        </Button>
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

// Package Health Panel Content
interface PackageHealthPanelContentProps {
  panel: PackageHealthPanel;
}

function PackageHealthPanelContent({ panel }: PackageHealthPanelContentProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/50 flex-shrink-0 bg-zinc-900/30">
        <div className="text-xs text-zinc-500">
          <span className="text-zinc-300">{panel.projectName}</span> — {panel.title}
        </div>
        <span className="text-xs text-zinc-600">
          {panel.subType === 'outdated' ? 'pnpm outdated' : 'pnpm audit'}
        </span>
      </div>

      {/* Output content */}
      <div className="flex-1 overflow-auto p-4" ref={scrollRef}>
        <pre className="font-mono text-xs text-zinc-300 whitespace-pre-wrap">
          {panel.rawOutput || 'No output available'}
        </pre>
      </div>
    </>
  );
}
