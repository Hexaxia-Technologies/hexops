'use client';

import type { SourceResult } from '@/lib/security/types';

const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  'pnpm-audit': 'pnpm-audit',
  grype: 'grype',
  'cve-lite': 'cve-lite',
  'dependency-health': 'dependency-health',
  'override-hygiene': 'override-hygiene',
};

const SOURCE_SCOPE: Record<string, string> = {
  'pnpm-audit': 'lockfile scanner',
  'cve-lite':   'lockfile scanner',
  'grype':      'filesystem/binary scanner',
  'dependency-health': 'manifest/source scanner',
  'override-hygiene':  'manifest override auditor',
};

interface Tone {
  dot: string;
  text: string;
  border: string;
  label: string;
}

function pickTone(status: SourceResult['status'], findingCount: number, warning?: string): Tone {
  if (status !== 'ok') {
    const map: Record<Exclude<SourceResult['status'], 'ok'>, Tone> = {
      failed:      { dot: 'bg-red-500',    text: 'text-red-400',    border: 'border-red-700/60',           label: 'failed'      },
      unavailable: { dot: 'bg-zinc-500',   text: 'text-zinc-400',   border: 'border-zinc-800 opacity-70',  label: 'unavailable' },
      timeout:     { dot: 'bg-orange-500', text: 'text-orange-400', border: 'border-orange-700/60',        label: 'timeout'     },
    };
    return map[status];
  }
  if (warning) {
    // Succeeded but did not cover everything — never show this as clean.
    return { dot: 'bg-amber-500', text: 'text-amber-400', border: 'border-amber-700/60', label: 'partial' };
  }
  if (findingCount === 0) {
    return { dot: 'bg-green-500', text: 'text-green-400', border: 'border-zinc-800', label: 'clean' };
  }
  // ok + findings > 0 — needs attention
  return {
    dot: 'bg-amber-500',
    text: 'text-amber-400',
    border: 'border-amber-700/60',
    label: `${findingCount} finding${findingCount === 1 ? '' : 's'}`,
  };
}

export interface SourceCardProps {
  result: SourceResult;
  deepLinkHref?: string;
}

export function SourceCard({ result, deepLinkHref }: SourceCardProps) {
  const tone = pickTone(result.status, result.findingCount, result.warning);
  const display = SOURCE_DISPLAY_NAMES[result.id] ?? result.id;

  return (
    <div
      className={`rounded-md border ${tone.border} bg-zinc-900/30 px-3 py-3 text-sm`}
    >
      <div className="flex items-center justify-between">
        <div className="font-medium text-zinc-100">{display}</div>
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
          <span className={`text-xs ${tone.text}`}>{tone.label}</span>
        </div>
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        ScanSource · {Math.round(result.durationMs)}ms
      </div>
      {SOURCE_SCOPE[result.id] && (
        <div className="mt-0.5 text-[0.65rem] text-zinc-600 italic">
          {SOURCE_SCOPE[result.id]}
        </div>
      )}
      {result.warning && (
        <div className="mt-1 text-[0.65rem] text-amber-400">{result.warning}</div>
      )}
      {deepLinkHref && (
        <a
          href={deepLinkHref}
          className="mt-2 inline-block text-xs text-blue-400 hover:text-blue-300"
        >
          Open dashboard ↗
        </a>
      )}
    </div>
  );
}
