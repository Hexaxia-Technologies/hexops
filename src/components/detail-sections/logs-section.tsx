'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { LogEntry } from '@/lib/types';

interface LogsSectionProps {
  projectId: string;
  isRunning: boolean;
}

export function LogsSection({ projectId, isRunning }: LogsSectionProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isRunning) {
      setLogs([]);
      return;
    }

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
  }, [projectId, isRunning]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  if (!isRunning) {
    return (
      <div className="text-center py-8 text-zinc-500 text-sm">
        Start the project to view logs
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-500">
          {logs.length} log entries
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={`text-xs h-7 ${autoScroll ? 'text-purple-400' : 'text-zinc-500'}`}
          onClick={() => setAutoScroll(!autoScroll)}
        >
          {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
        </Button>
      </div>

      <div
        ref={scrollRef}
        className="h-64 overflow-auto bg-zinc-900 rounded-md p-3 font-mono text-xs"
      >
        {logs.length === 0 ? (
          <p className="text-zinc-600">Waiting for logs...</p>
        ) : (
          <div className="space-y-1">
            {logs.map((log, i) => (
              <div
                key={i}
                className={log.type === 'stderr' ? 'text-red-400' : 'text-zinc-300'}
              >
                <span className="text-zinc-600 mr-2">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="whitespace-pre-wrap">{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
