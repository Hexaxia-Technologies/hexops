'use client';

import { Sidebar } from '@/components/sidebar';
import { LogViewer } from '@/components/log-viewer';

export default function LogsPage() {
  return (
    <div className="flex h-screen bg-zinc-950">
      <Sidebar />

      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="border-b border-zinc-800 px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Logs</h1>
            <p className="text-xs text-zinc-500 mt-1">
              System-wide activity and event logs
            </p>
          </div>
        </header>

        <LogViewer className="flex-1" />
      </main>
    </div>
  );
}
