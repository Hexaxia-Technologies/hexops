'use client';

import { cn } from '@/lib/utils';
import { APP_VERSION } from '@/lib/version';

interface SidebarProps {
  categories: string[];
  selectedCategory: string | null;
  onSelectCategory: (category: string | null) => void;
  projectCounts: Record<string, number>;
  runningCount: number;
  totalCount: number;
}

export function Sidebar({
  categories,
  selectedCategory,
  onSelectCategory,
  projectCounts,
  runningCount,
  totalCount,
}: SidebarProps) {
  return (
    <aside className="w-48 bg-zinc-950 border-r border-zinc-800 p-4 flex flex-col">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-purple-400">HexOps</h1>
        <p className="text-xs text-zinc-500 mt-1">Dev Project Manager</p>
      </div>

      <nav className="flex-1 space-y-1">
        <button
          onClick={() => onSelectCategory(null)}
          className={cn(
            'w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between',
            selectedCategory === null
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
          )}
        >
          <span>All</span>
          <span className="text-xs text-zinc-500">{totalCount}</span>
        </button>

        <button
          onClick={() => onSelectCategory('running')}
          className={cn(
            'w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between',
            selectedCategory === 'running'
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
          )}
        >
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            Running
          </span>
          <span className="text-xs text-zinc-500">{runningCount}</span>
        </button>

        <button
          onClick={() => onSelectCategory('stopped')}
          className={cn(
            'w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between',
            selectedCategory === 'stopped'
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
          )}
        >
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-zinc-600" />
            Stopped
          </span>
          <span className="text-xs text-zinc-500">{totalCount - runningCount}</span>
        </button>

        <div className="h-px bg-zinc-800 my-3" />

        {categories.map((category) => (
          <button
            key={category}
            onClick={() => onSelectCategory(category)}
            className={cn(
              'w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between',
              selectedCategory === category
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
            )}
          >
            <span>{category}</span>
            <span className="text-xs text-zinc-500">
              {projectCounts[category] || 0}
            </span>
          </button>
        ))}
      </nav>

      <div className="pt-4 border-t border-zinc-800 space-y-1">
        <p className="text-xs text-zinc-600 text-center">
          {runningCount} of {totalCount} running
        </p>
        <p className="text-[10px] text-zinc-700 text-center">
          v{APP_VERSION}
        </p>
      </div>
    </aside>
  );
}
