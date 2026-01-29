'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RefreshCw, Search, ChevronDown, ChevronRight, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LogEntry, LogLevel, LogCategory } from '@/lib/logger';

interface LogViewerProps {
  projectId?: string; // Pre-filter to a specific project
  showProjectFilter?: boolean; // Show project dropdown
  className?: string;
}

interface LogsResponse {
  logs: LogEntry[];
  total: number;
  returned: number;
  hasMore: boolean;
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: 'text-zinc-500',
  info: 'text-zinc-300',
  warn: 'text-yellow-400',
  error: 'text-red-400',
};

const LEVEL_BG: Record<LogLevel, string> = {
  debug: 'bg-zinc-500/10 border-zinc-500/30',
  info: 'bg-blue-500/10 border-blue-500/30',
  warn: 'bg-yellow-500/10 border-yellow-500/30',
  error: 'bg-red-500/10 border-red-500/30',
};

const CATEGORY_COLORS: Record<LogCategory, string> = {
  patches: 'text-purple-400',
  projects: 'text-blue-400',
  git: 'text-green-400',
  api: 'text-orange-400',
  system: 'text-zinc-400',
};

export function LogViewer({ projectId, showProjectFilter = true, className }: LogViewerProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // Filters
  const [level, setLevel] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [selectedProject, setSelectedProject] = useState<string>(projectId || 'all');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');

  // Available projects for filter
  const [projects, setProjects] = useState<string[]>([]);

  // Live mode
  const [liveMode, setLiveMode] = useState(false);

  // Expanded rows
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Fetch projects list
  useEffect(() => {
    if (!showProjectFilter) return;
    fetch('/api/logs?projects=true')
      .then(res => res.json())
      .then(data => setProjects(data.projects || []))
      .catch(() => {});
  }, [showProjectFilter]);

  // Fetch logs
  const fetchLogs = useCallback(async (append = false) => {
    if (!append) setLoading(true);

    const params = new URLSearchParams();
    if (level !== 'all') params.set('level', level);
    if (category !== 'all') params.set('category', category);
    if (selectedProject !== 'all') params.set('projectId', selectedProject);
    if (searchDebounced) params.set('search', searchDebounced);
    if (append && logs.length > 0) {
      params.set('before', logs[logs.length - 1].ts);
    }
    params.set('limit', '100');

    try {
      const res = await fetch(`/api/logs?${params}`);
      const data: LogsResponse = await res.json();

      if (append) {
        setLogs(prev => [...prev, ...data.logs]);
      } else {
        setLogs(data.logs);
      }
      setTotal(data.total);
      setHasMore(data.hasMore);
    } catch (error) {
      console.error('Failed to fetch logs:', error);
    } finally {
      setLoading(false);
    }
  }, [level, category, selectedProject, searchDebounced, logs]);

  // Initial fetch and refetch on filter change
  useEffect(() => {
    fetchLogs(false);
  }, [level, category, selectedProject, searchDebounced]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live mode polling
  useEffect(() => {
    if (!liveMode) return;
    const interval = setInterval(() => fetchLogs(false), 2000);
    return () => clearInterval(interval);
  }, [liveMode, fetchLogs]);

  // Update selectedProject when prop changes
  useEffect(() => {
    if (projectId) setSelectedProject(projectId);
  }, [projectId]);

  const toggleRow = (ts: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(ts)) {
        next.delete(ts);
      } else {
        next.add(ts);
      }
      return next;
    });
  };

  const formatTime = (ts: string) => {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-GB', { hour12: false });
  };

  const formatDate = (ts: string) => {
    const date = new Date(ts);
    return date.toLocaleDateString('en-CA');
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Filters */}
      <div className="flex items-center gap-3 p-4 border-b border-zinc-800 bg-zinc-900/50 flex-wrap">
        {/* Level filter */}
        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger className="w-[120px] h-8 text-xs">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="warn">Warn</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>

        {/* Category filter */}
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-[130px] h-8 text-xs">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="patches">Patches</SelectItem>
            <SelectItem value="projects">Projects</SelectItem>
            <SelectItem value="git">Git</SelectItem>
            <SelectItem value="api">API</SelectItem>
            <SelectItem value="system">System</SelectItem>
          </SelectContent>
        </Select>

        {/* Project filter */}
        {showProjectFilter && !projectId && (
          <Select value={selectedProject} onValueChange={setSelectedProject}>
            <SelectTrigger className="w-[150px] h-8 text-xs">
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Projects</SelectItem>
              {projects.map(p => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
          <Input
            placeholder="Search logs..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>

        {/* Live mode toggle */}
        <Button
          variant={liveMode ? 'secondary' : 'ghost'}
          size="sm"
          className={cn('h-8 text-xs', liveMode && 'bg-green-500/20 text-green-400')}
          onClick={() => setLiveMode(!liveMode)}
        >
          <Radio className={cn('h-3.5 w-3.5 mr-1.5', liveMode && 'animate-pulse')} />
          Live
        </Button>

        {/* Refresh */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs"
          onClick={() => fetchLogs(false)}
          disabled={loading}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-auto">
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
            Loading logs...
          </div>
        ) : logs.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
            No logs found
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/50">
            {logs.map((log, idx) => {
              const isExpanded = expandedRows.has(log.ts + idx);
              return (
                <div key={log.ts + idx} className="hover:bg-zinc-900/50">
                  <div
                    className="flex items-start gap-3 px-4 py-2 cursor-pointer"
                    onClick={() => toggleRow(log.ts + idx)}
                  >
                    {/* Expand toggle */}
                    <button className="mt-0.5 text-zinc-600 hover:text-zinc-400">
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>

                    {/* Timestamp */}
                    <span className="text-xs text-zinc-600 font-mono w-[65px] flex-shrink-0">
                      {formatTime(log.ts)}
                    </span>

                    {/* Level badge */}
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px] uppercase w-12 justify-center flex-shrink-0',
                        LEVEL_BG[log.level],
                        LEVEL_COLORS[log.level]
                      )}
                    >
                      {log.level}
                    </Badge>

                    {/* Category */}
                    <span className={cn('text-xs w-16 flex-shrink-0', CATEGORY_COLORS[log.category])}>
                      {log.category}
                    </span>

                    {/* Project */}
                    <span className="text-xs text-zinc-500 w-24 flex-shrink-0 truncate">
                      {log.projectId || '—'}
                    </span>

                    {/* Message */}
                    <span className={cn('text-xs flex-1 truncate', LEVEL_COLORS[log.level])}>
                      {log.message}
                    </span>
                  </div>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="px-4 pb-3 pl-12">
                      <div className="bg-zinc-900 rounded border border-zinc-800 p-3 text-xs font-mono">
                        <div className="grid grid-cols-2 gap-2 mb-2">
                          <div>
                            <span className="text-zinc-500">Timestamp:</span>{' '}
                            <span className="text-zinc-300">{formatDate(log.ts)} {formatTime(log.ts)}</span>
                          </div>
                          <div>
                            <span className="text-zinc-500">Action:</span>{' '}
                            <span className="text-zinc-300">{log.action}</span>
                          </div>
                        </div>
                        {log.meta && (
                          <div>
                            <span className="text-zinc-500">Metadata:</span>
                            <pre className="mt-1 text-zinc-400 whitespace-pre-wrap overflow-x-auto">
                              {JSON.stringify(log.meta, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-zinc-800 bg-zinc-900/50 text-xs text-zinc-500">
        <span>
          Showing {logs.length} of {total} entries
        </span>
        {hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => fetchLogs(true)}
            disabled={loading}
          >
            Load More
          </Button>
        )}
      </div>
    </div>
  );
}
