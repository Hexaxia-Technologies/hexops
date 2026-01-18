'use client';

import { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { ProjectRow } from './project-row';
import { cn } from '@/lib/utils';
import type { Project } from '@/lib/types';

type SortField = 'status' | 'name' | 'category' | 'port';
type SortDirection = 'asc' | 'desc';

interface ProjectListProps {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStart: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onViewLogs: (id: string) => void;
  onViewDetails: (id: string) => void;
  onClearCache: (id: string) => Promise<void>;
  onDeleteLock: (id: string) => Promise<void>;
}

export function ProjectList({
  projects,
  selectedId,
  onSelect,
  onStart,
  onStop,
  onViewLogs,
  onViewDetails,
  onClearCache,
  onDeleteLock,
}: ProjectListProps) {
  const [sortField, setSortField] = useState<SortField>(() => {
    if (typeof window === 'undefined') return 'name';
    return (localStorage.getItem('hexops-sort-field') as SortField) || 'name';
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    if (typeof window === 'undefined') return 'asc';
    return (localStorage.getItem('hexops-sort-direction') as SortDirection) || 'asc';
  });

  // Persist sort preferences
  useEffect(() => {
    localStorage.setItem('hexops-sort-field', sortField);
    localStorage.setItem('hexops-sort-direction', sortDirection);
  }, [sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'status':
          // Running first when ascending
          comparison = (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1);
          break;
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'category':
          comparison = (a.category || '').localeCompare(b.category || '');
          break;
        case 'port':
          comparison = a.port - b.port;
          break;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [projects, sortField, sortDirection]);

  if (projects.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-zinc-500">No projects match the filter</p>
      </div>
    );
  }

  return (
    <motion.div className="flex flex-col" layout>
      {/* Header row - matches grid-cols from ProjectRow */}
      <div className="grid grid-cols-[24px_140px_1fr_90px_40px_70px_55px_55px_45px_28px_28px_28px_28px_56px_72px] items-center gap-2 px-4 py-2 border-b border-zinc-700 bg-zinc-900/50 text-[10px] text-zinc-500 uppercase tracking-wider sticky top-0">
        <SortHeader field="status" current={sortField} direction={sortDirection} onSort={handleSort} center>
          STATUS
        </SortHeader>
        <SortHeader field="name" current={sortField} direction={sortDirection} onSort={handleSort}>
          NAME
        </SortHeader>
        <div>DESC</div>
        <div className="text-center" title="Git branch">GIT</div>
        <div className="text-center" title="Outdated packages">PKGS</div>
        <SortHeader field="category" current={sortField} direction={sortDirection} onSort={handleSort} center>
          CATEGORY
        </SortHeader>
        <SortHeader field="port" current={sortField} direction={sortDirection} onSort={handleSort} center>
          PORT
        </SortHeader>
        <div className="text-center" title="Process uptime">UPTIME</div>
        <div className="text-center" title="Memory usage">MEM</div>
        <div className="text-center" title="Open in browser">OPEN</div>
        <div className="text-center" title="View logs">LOGS</div>
        <div className="text-center" title="Clear cache">CACHE</div>
        <div className="text-center" title="Delete lock">LOCK</div>
        <div className="text-center">POWER</div>
        <div className="text-center">DETAILS</div>
      </div>

      {/* Project rows */}
      {sortedProjects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          isSelected={selectedId === project.id}
          onSelect={onSelect}
          onStart={onStart}
          onStop={onStop}
          onViewLogs={onViewLogs}
          onViewDetails={onViewDetails}
          onClearCache={onClearCache}
          onDeleteLock={onDeleteLock}
        />
      ))}
    </motion.div>
  );
}

// Sortable header component
interface SortHeaderProps {
  field: SortField;
  current: SortField;
  direction: SortDirection;
  onSort: (field: SortField) => void;
  center?: boolean;
  children: React.ReactNode;
}

function SortHeader({ field, current, direction, onSort, center, children }: SortHeaderProps) {
  const isActive = current === field;

  return (
    <button
      onClick={() => onSort(field)}
      className={cn(
        'flex items-center gap-1 hover:text-zinc-300 transition-colors text-[10px]',
        center && 'justify-center',
        isActive && 'text-zinc-300'
      )}
    >
      <span>{children}</span>
      {isActive && (
        direction === 'asc'
          ? <ChevronUp className="h-3 w-3" />
          : <ChevronDown className="h-3 w-3" />
      )}
    </button>
  );
}
