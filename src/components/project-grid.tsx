'use client';

import { motion } from 'framer-motion';
import { ProjectCard } from './project-card';
import type { Project } from '@/lib/types';

interface ProjectGridProps {
  projects: Project[];
  onStart: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onViewLogs: (id: string) => void;
  onClearCache: (id: string) => Promise<void>;
  onDeleteLock: (id: string) => Promise<void>;
}

export function ProjectGrid({ projects, onStart, onStop, onViewLogs, onClearCache, onDeleteLock }: ProjectGridProps) {
  if (projects.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-zinc-500">No projects match the filter</p>
      </div>
    );
  }

  return (
    <motion.div
      className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
      layout
    >
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
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
