'use client';
import { useState } from 'react';
import type { SourceResult } from '@/lib/security/types';

function relTime(ts?: string | null) {
  if (!ts) return 'never';
  const diffMs = Date.now() - new Date(ts).getTime();
  const m = Math.round(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const STATUS_COLOR: Record<SourceResult['status'], string> = {
  ok: 'text-green-400',
  failed: 'text-red-400',
  unavailable: 'text-zinc-500',
  timeout: 'text-yellow-400',
  skipped: 'text-sky-400',
  misconfigured: 'text-red-400',
};

const STATUS_ICON: Record<SourceResult['status'], string> = {
  ok: '✓',
  failed: '✗',
  unavailable: '✗',
  timeout: '✗',
  skipped: '–',
  misconfigured: '⚠',
};

interface Props {
  projectId: string;
  sources: Record<string, SourceResult>;
  onRescan: () => void;
}

export function SourceStrip({ projectId, sources, onRescan }: Props) {
  const [scanning, setScanning] = useState(false);
  const entries = Object.entries(sources);

  const trigger = async () => {
    setScanning(true);
    try {
      await fetch(`/api/projects/${projectId}/security-scan`, { method: 'POST' });
      onRescan();
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="flex items-center gap-3 text-xs text-zinc-400">
      {entries.length === 0 && <span>No scan recorded yet.</span>}
      {entries.map(([id, r]) => (
        <span key={id} className="flex items-center gap-1">
          <span className="font-medium text-zinc-300">{id}</span>
          <span className={STATUS_COLOR[r.status]}>{STATUS_ICON[r.status]}</span>
          <span>{relTime(r.startedAt)}</span>
          {r.error && r.status === 'skipped' && (
            <span className="text-sky-400" title={r.error}>· skipped</span>
          )}
          {r.error && r.status !== 'skipped' && (
            <span className="text-red-400" title={r.error}>· error</span>
          )}
        </span>
      ))}
      <button
        type="button"
        onClick={trigger}
        disabled={scanning}
        className="ml-auto text-xs px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800 disabled:opacity-50"
      >
        {scanning ? 'Scanning…' : 'Rescan'}
      </button>
    </div>
  );
}
