'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  ExternalLink,
  Play,
  Square,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Project } from '@/lib/types';

// Collapsible section components
import { LogsSection } from './detail-sections/logs-section';
import { InfoSection } from './detail-sections/info-section';
import { GitSection } from './detail-sections/git-section';
import { PackageHealthSection } from './detail-sections/package-health-section';

interface ProjectDetailProps {
  project: Project;
  onBack: () => void;
  onStart: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onClearCache: (id: string) => Promise<void>;
  onDeleteLock: (id: string) => Promise<void>;
  onRefresh: () => void;
}

export function ProjectDetail({
  project,
  onBack,
  onStart,
  onStop,
  onClearCache,
  onDeleteLock,
  onRefresh,
}: ProjectDetailProps) {
  const [isToggling, setIsToggling] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const isRunning = project.status === 'running';

  const handleToggle = async () => {
    setIsToggling(true);
    try {
      if (isRunning) {
        await onStop(project.id);
      } else {
        await onStart(project.id);
      }
      onRefresh();
    } finally {
      setIsToggling(false);
    }
  };

  const handleClearCache = async () => {
    setActionLoading('cache');
    try {
      await onClearCache(project.id);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteLock = async () => {
    setActionLoading('lock');
    try {
      await onDeleteLock(project.id);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-zinc-400 hover:text-zinc-100"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>

          <div className="h-6 w-px bg-zinc-700" />

          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-zinc-100">{project.name}</h1>
              <Badge
                variant="outline"
                className={cn(
                  'text-xs',
                  isRunning
                    ? 'border-green-500/50 text-green-400 bg-green-500/10'
                    : 'border-zinc-600 text-zinc-500'
                )}
              >
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full mr-1.5',
                    isRunning ? 'bg-green-500' : 'bg-zinc-600'
                  )}
                />
                {isRunning ? 'Running' : 'Stopped'}
              </Badge>
              <Badge variant="secondary" className="text-xs bg-zinc-800 text-zinc-400">
                :{project.port}
              </Badge>
            </div>
            <p className="text-xs text-zinc-500 mt-0.5 font-mono">{project.path}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isRunning && (
            <a
              href={`http://localhost:${project.port}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 h-8 px-3 text-xs text-purple-400 hover:text-purple-300 hover:bg-zinc-800 rounded-md transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in Browser
            </a>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-zinc-400 hover:text-zinc-100"
            onClick={handleClearCache}
            disabled={actionLoading === 'cache'}
          >
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', actionLoading === 'cache' && 'animate-spin')} />
            Clear Cache
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-zinc-400 hover:text-zinc-100"
            onClick={handleDeleteLock}
            disabled={actionLoading === 'lock'}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Delete Lock
          </Button>

          <Button
            variant={isRunning ? 'destructive' : 'default'}
            size="sm"
            className={cn(
              'h-8 text-xs',
              !isRunning && 'bg-purple-600 hover:bg-purple-700'
            )}
            onClick={handleToggle}
            disabled={isToggling}
          >
            {isToggling ? (
              '...'
            ) : isRunning ? (
              <>
                <Square className="h-3.5 w-3.5 mr-1.5" />
                Stop
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 mr-1.5" />
                Start
              </>
            )}
          </Button>
        </div>
      </header>

      {/* Content - Collapsible Sections */}
      <div className="flex-1 overflow-auto p-6 space-y-4">
        <CollapsibleSection title="Logs" defaultOpen={isRunning}>
          <LogsSection projectId={project.id} isRunning={isRunning} />
        </CollapsibleSection>

        <CollapsibleSection title="Project Info" defaultOpen>
          <InfoSection projectId={project.id} projectPath={project.path} />
        </CollapsibleSection>

        <CollapsibleSection title="Git">
          <GitSection projectId={project.id} projectPath={project.path} />
        </CollapsibleSection>

        <CollapsibleSection title="Package Health">
          <PackageHealthSection projectId={project.id} projectPath={project.path} />
        </CollapsibleSection>
      </div>
    </div>
  );
}

// Collapsible section wrapper
interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function CollapsibleSection({ title, defaultOpen = false, children }: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 bg-zinc-900/50 hover:bg-zinc-900 transition-colors"
      >
        <span className="text-sm font-medium text-zinc-200">{title}</span>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-zinc-500" />
        ) : (
          <ChevronRight className="h-4 w-4 text-zinc-500" />
        )}
      </button>
      {isOpen && (
        <div className="p-4 border-t border-zinc-800 bg-zinc-950">
          {children}
        </div>
      )}
    </div>
  );
}
