'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, FileText, Trash2, RefreshCw, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Project } from '@/lib/types';

interface ProjectRowProps {
  project: Project;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onStart: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onViewLogs: (id: string) => void;
  onViewDetails: (id: string) => void;
  onClearCache: (id: string) => Promise<void>;
  onDeleteLock: (id: string) => Promise<void>;
}

export function ProjectRow({
  project,
  isSelected,
  onSelect,
  onStart,
  onStop,
  onViewLogs,
  onViewDetails,
  onClearCache,
  onDeleteLock,
}: ProjectRowProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLoading(true);
    try {
      if (project.status === 'running') {
        await onStop(project.id);
      } else {
        await onStart(project.id);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearCache = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setActionLoading('cache');
    try {
      await onClearCache(project.id);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteLock = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setActionLoading('lock');
    try {
      await onDeleteLock(project.id);
    } finally {
      setActionLoading(null);
    }
  };

  const handleViewLogs = (e: React.MouseEvent) => {
    e.stopPropagation();
    onViewLogs(project.id);
  };

  const handleViewDetails = (e: React.MouseEvent) => {
    e.stopPropagation();
    onViewDetails(project.id);
  };

  const isRunning = project.status === 'running';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      onClick={() => onSelect(project.id)}
      className={cn(
        'grid grid-cols-[48px_1fr_80px_64px_28px_28px_28px_28px_56px_72px] items-center gap-3 px-4 py-3 border-b border-zinc-800/50 cursor-pointer transition-colors',
        isSelected
          ? 'bg-zinc-800/80 border-l-2 border-l-purple-500'
          : 'hover:bg-zinc-900/50'
      )}
    >
      {/* Status indicator */}
      <div className="flex justify-center">
        <motion.div
          className={cn(
            'w-2.5 h-2.5 rounded-full',
            isRunning ? 'bg-green-500' : 'bg-zinc-600'
          )}
          animate={isRunning ? { scale: [1, 1.2, 1] } : {}}
          transition={{ repeat: Infinity, duration: 2 }}
        />
      </div>

      {/* Project name */}
      <div className="min-w-0">
        <span className="text-sm font-medium text-zinc-100 truncate block">
          {project.name}
        </span>
      </div>

      {/* Category */}
      <div className="flex justify-center">
        <Badge
          variant="secondary"
          className="bg-zinc-800 text-zinc-400 text-xs"
        >
          {project.category}
        </Badge>
      </div>

      {/* Port */}
      <div className="flex justify-center">
        <Badge
          variant="outline"
          className={cn(
            'text-xs font-mono',
            isRunning
              ? 'border-green-500/50 text-green-400'
              : 'border-zinc-700 text-zinc-500'
          )}
        >
          :{project.port}
        </Badge>
      </div>

      {/* Open in browser */}
      <div className="flex justify-center">
        <a
          href={`http://localhost:${project.port}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.stopPropagation();
            if (!isRunning) e.preventDefault();
          }}
          className={cn(
            'inline-flex items-center justify-center h-7 w-7 rounded transition-colors',
            isRunning
              ? 'text-purple-400 hover:text-purple-300 hover:bg-zinc-700'
              : 'text-zinc-700 cursor-default'
          )}
          title={isRunning ? 'Open in browser' : ''}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* View logs */}
      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 w-7 p-0',
            isRunning
              ? 'text-zinc-400 hover:text-zinc-100'
              : 'text-zinc-700 cursor-default hover:bg-transparent'
          )}
          onClick={isRunning ? handleViewLogs : undefined}
          title={isRunning ? 'View logs' : ''}
          disabled={!isRunning}
        >
          <FileText className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Clear cache */}
      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-zinc-500 hover:text-zinc-300"
          onClick={handleClearCache}
          disabled={actionLoading === 'cache'}
          title="Clear .next cache"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', actionLoading === 'cache' && 'animate-spin')} />
        </Button>
      </div>

      {/* Delete lock */}
      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-zinc-500 hover:text-zinc-300"
          onClick={handleDeleteLock}
          disabled={actionLoading === 'lock'}
          title="Delete lock file"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Power (Start/Stop) */}
      <div className="flex justify-center">
        <Button
          variant={isRunning ? 'destructive' : 'default'}
          size="sm"
          className={cn(
            'h-7 w-14 text-xs',
            !isRunning && 'bg-purple-600 hover:bg-purple-700 text-white'
          )}
          onClick={handleToggle}
          disabled={isLoading}
        >
          {isLoading ? '...' : isRunning ? 'Stop' : 'Start'}
        </Button>
      </div>

      {/* Details */}
      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-zinc-400 hover:text-zinc-100"
          onClick={handleViewDetails}
          title="View details"
        >
          Details
          <ChevronRight className="h-3.5 w-3.5 ml-1" />
        </Button>
      </div>
    </motion.div>
  );
}
