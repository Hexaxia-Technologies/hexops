'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Project } from '@/lib/types';

interface ProjectCardProps {
  project: Project;
  onStart: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onViewLogs: (id: string) => void;
  onClearCache: (id: string) => Promise<void>;
  onDeleteLock: (id: string) => Promise<void>;
}

export function ProjectCard({ project, onStart, onStop, onViewLogs, onClearCache, onDeleteLock }: ProjectCardProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleToggle = async () => {
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

  const isRunning = project.status === 'running';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
    >
      <Card className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition-colors">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <motion.div
                className={`w-2.5 h-2.5 rounded-full ${
                  isRunning ? 'bg-green-500' : 'bg-zinc-600'
                }`}
                animate={isRunning ? { scale: [1, 1.2, 1] } : {}}
                transition={{ repeat: Infinity, duration: 2 }}
              />
              <CardTitle className="text-base font-medium text-zinc-100">
                {project.name}
              </CardTitle>
            </div>
            <Badge
              variant="outline"
              className={`text-xs ${
                isRunning
                  ? 'border-green-500/50 text-green-400'
                  : 'border-zinc-700 text-zinc-500'
              }`}
            >
              :{project.port}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-2 space-y-2">
          <div className="flex items-center justify-between">
            <Badge
              variant="secondary"
              className="bg-zinc-800 text-zinc-400 text-xs"
            >
              {project.category}
            </Badge>
            <div className="flex gap-2">
              {isRunning && (
                <>
                  <a
                    href={`http://localhost:${project.port}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center h-7 px-2 text-xs text-purple-400 hover:text-purple-300 hover:bg-zinc-800 rounded-md transition-colors"
                  >
                    Open
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-zinc-400 hover:text-zinc-100"
                    onClick={() => onViewLogs(project.id)}
                  >
                    Logs
                  </Button>
                </>
              )}
              <Button
                variant={isRunning ? 'destructive' : 'default'}
                size="sm"
                className={`h-7 px-3 text-xs ${
                  !isRunning
                    ? 'bg-purple-600 hover:bg-purple-700 text-white'
                    : ''
                }`}
                onClick={handleToggle}
                disabled={isLoading}
              >
                {isLoading ? '...' : isRunning ? 'Stop' : 'Start'}
              </Button>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-zinc-500 hover:text-zinc-300"
              onClick={handleClearCache}
              disabled={actionLoading === 'cache'}
            >
              {actionLoading === 'cache' ? '...' : 'Clear Cache'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-zinc-500 hover:text-zinc-300"
              onClick={handleDeleteLock}
              disabled={actionLoading === 'lock'}
            >
              {actionLoading === 'lock' ? '...' : 'Delete Lock'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
