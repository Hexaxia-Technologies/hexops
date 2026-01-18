'use client';

import { motion } from 'framer-motion';
import { ProjectRow } from './project-row';
import type { Project } from '@/lib/types';

interface ProjectListProps {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStart: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onViewLogs: (id: string) => void;
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
  onClearCache,
  onDeleteLock,
}: ProjectListProps) {
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
      <div className="grid grid-cols-[24px_1fr_80px_64px_200px] items-center gap-4 px-4 py-2 border-b border-zinc-700 bg-zinc-900/50 text-xs text-zinc-500 uppercase tracking-wider sticky top-0">
        <div className="text-center">●</div>
        <div>Name</div>
        <div className="text-center">Category</div>
        <div className="text-center">Port</div>
        <div className="text-right">Actions</div>
      </div>

      {/* Project rows */}
      {projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          isSelected={selectedId === project.id}
          onSelect={onSelect}
          onStart={onStart}
          onStop={onStop}
          onViewLogs={onViewLogs}
          onClearCache={onClearCache}
          onDeleteLock={onDeleteLock}
        />
      ))}
    </motion.div>
  );
}
