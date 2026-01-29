'use client';

import Link from 'next/link';
import { Package, Plus, TerminalSquare, ScrollText, LayoutDashboard } from 'lucide-react';
import { cn } from '@/lib/utils';
import { APP_VERSION } from '@/lib/version';
import { useSidebar } from '@/contexts/sidebar-context';

interface SidebarProps {
  selectedCategory?: string | null;
  onSelectCategory?: (category: string | null) => void;
  onAddProject?: () => void;
  onOpenShell?: () => void;
}

export function Sidebar({
  selectedCategory = null,
  onSelectCategory,
  onAddProject,
  onOpenShell,
}: SidebarProps) {
  const { categories, projectCounts, runningCount, totalCount } = useSidebar();

  // If no category handler provided, make buttons non-interactive (just display)
  const handleCategoryClick = (category: string | null) => {
    if (onSelectCategory) {
      onSelectCategory(category);
    }
  };

  return (
    <aside className="w-48 bg-zinc-950 border-r border-zinc-800 p-4 flex flex-col">
      <Link href="/" className="block mb-6 group">
        <h1 className="text-xl font-bold text-purple-400 group-hover:text-purple-300 transition-colors">HexOps</h1>
        <p className="text-xs text-zinc-500 mt-1">Dev Project Manager</p>
      </Link>

      <nav className="flex-1 space-y-1">
        <button
          onClick={() => handleCategoryClick(null)}
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
          onClick={() => handleCategoryClick('running')}
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
          onClick={() => handleCategoryClick('stopped')}
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
            onClick={() => handleCategoryClick(category)}
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

        {onAddProject && (
          <button
            onClick={onAddProject}
            className="w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800/50 mt-2"
          >
            <Plus className="h-4 w-4" />
            Add Project
          </button>
        )}

        <div className="h-px bg-zinc-800 my-3" />

        <Link
          href="/"
          className={cn(
            'w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2',
            'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
          )}
        >
          <LayoutDashboard className="h-4 w-4" />
          Dashboard
        </Link>

        <Link
          href="/patches"
          className={cn(
            'w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2',
            'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
          )}
        >
          <Package className="h-4 w-4" />
          Patches
        </Link>

        <Link
          href="/logs"
          className={cn(
            'w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2',
            'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
          )}
        >
          <ScrollText className="h-4 w-4" />
          Logs
        </Link>

        {onOpenShell && (
          <button
            onClick={onOpenShell}
            className="w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50"
          >
            <TerminalSquare className="h-4 w-4" />
            Shell
          </button>
        )}
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
