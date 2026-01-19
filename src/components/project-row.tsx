'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, FileText, Trash2, RefreshCw, ChevronRight, GitBranch, CheckCircle } from 'lucide-react';
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

// Format uptime from milliseconds to human readable
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// Format memory in MB
function formatMemory(mb: number): string {
  if (mb < 1024) return `${mb}M`;
  return `${(mb / 1024).toFixed(1)}G`;
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
  const ext = project.extended;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      onClick={() => onSelect(project.id)}
      className={cn(
        'grid grid-cols-[48px_140px_1fr_90px_40px_70px_55px_55px_45px_36px_36px_36px_36px_56px_72px] items-center gap-2 px-4 py-3 border-b border-zinc-800/50 cursor-pointer transition-colors',
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

      {/* Description */}
      <div className="min-w-0">
        <span className="text-xs text-zinc-500 truncate block">
          {project.description || '—'}
        </span>
      </div>

      {/* Git branch + dirty indicator */}
      <div className="flex items-center gap-1 min-w-0">
        {ext?.git ? (
          <>
            <GitBranch className="h-3 w-3 text-zinc-600 flex-shrink-0" />
            <span className="text-xs text-zinc-400 truncate">{ext.git.branch}</span>
            {ext.git.dirty && (
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 flex-shrink-0" title="Uncommitted changes" />
            )}
          </>
        ) : (
          <span className="text-xs text-zinc-700">—</span>
        )}
      </div>

      {/* Package status */}
      <div className="flex justify-center">
        {ext?.packages !== undefined ? (
          ext.packages.criticalVulnerabilityCount && ext.packages.criticalVulnerabilityCount > 0 ? (
            <span
              className="text-xs text-red-500 font-medium"
              title={`${ext.packages.criticalVulnerabilityCount} critical/high vulnerabilities, ${ext.packages.outdatedCount} outdated`}
            >
              {ext.packages.outdatedCount > 0 ? ext.packages.outdatedCount : '!'}
            </span>
          ) : ext.packages.outdatedCount > 0 ? (
            // Check if all outdated packages are held
            ext.packages.heldCount === ext.packages.outdatedCount ? (
              <span
                className="text-xs text-zinc-500"
                title={`${ext.packages.outdatedCount} outdated (all held)`}
              >
                {ext.packages.outdatedCount}
              </span>
            ) : ext.packages.heldCount && ext.packages.heldCount > 0 ? (
              <span
                className="text-xs text-yellow-500"
                title={`${ext.packages.outdatedCount} outdated (${ext.packages.heldCount} held)`}
              >
                {ext.packages.outdatedCount}
              </span>
            ) : (
              <span className="text-xs text-yellow-500" title={`${ext.packages.outdatedCount} outdated`}>
                {ext.packages.outdatedCount}
              </span>
            )
          ) : (
            <span title="All packages up to date">
              <CheckCircle className="h-3.5 w-3.5 text-green-600" />
            </span>
          )
        ) : (
          <span className="text-xs text-zinc-700">—</span>
        )}
      </div>

      {/* Category */}
      <div className="flex justify-center">
        <Badge
          variant="secondary"
          className="bg-zinc-800 text-zinc-400 text-[10px] px-1.5"
        >
          {project.category}
        </Badge>
      </div>

      {/* Port */}
      <div className="flex justify-center">
        <Badge
          variant="outline"
          className={cn(
            'text-[10px] font-mono px-1.5',
            isRunning
              ? 'border-green-500/50 text-green-400'
              : 'border-zinc-700 text-zinc-500'
          )}
        >
          :{project.port}
        </Badge>
      </div>

      {/* Uptime */}
      <div className="flex justify-center">
        <span className={cn(
          'text-xs font-mono',
          isRunning && ext?.metrics?.uptime ? 'text-zinc-400' : 'text-zinc-700'
        )}>
          {isRunning && ext?.metrics?.uptime ? formatUptime(ext.metrics.uptime) : '—'}
        </span>
      </div>

      {/* Memory */}
      <div className="flex justify-center">
        <span className={cn(
          'text-xs font-mono',
          isRunning && ext?.metrics?.memory ? 'text-zinc-400' : 'text-zinc-700'
        )}>
          {isRunning && ext?.metrics?.memory ? formatMemory(ext.metrics.memory) : '—'}
        </span>
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
