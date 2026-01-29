'use client';

import { Sidebar } from '@/components/sidebar';
import { LogViewer } from '@/components/log-viewer';
import { useState, useEffect } from 'react';

interface CategoriesData {
  categories: string[];
}

export default function LogsPage() {
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    // Fetch categories for sidebar
    fetch('/api/patches')
      .then(res => res.json())
      .then((data: CategoriesData) => setCategories(data.categories || []))
      .catch(() => {});
  }, []);

  return (
    <div className="flex h-screen bg-zinc-950">
      {/* Left Sidebar */}
      <Sidebar
        categories={categories}
        selectedCategory={null}
        onSelectCategory={() => {}}
        projectCounts={{}}
        runningCount={0}
        totalCount={0}
        onAddProject={() => {}}
      />

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="border-b border-zinc-800 px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Logs</h1>
            <p className="text-xs text-zinc-500 mt-1">
              System-wide activity and event logs
            </p>
          </div>
        </header>

        {/* Log Viewer */}
        <LogViewer className="flex-1" />
      </main>
    </div>
  );
}
