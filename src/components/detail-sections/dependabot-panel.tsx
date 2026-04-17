'use client';

import { useEffect, useState } from 'react';
import type { DependabotConfig, DependabotPR } from '@/lib/types';

interface DependabotPanelProps {
  projectId: string;
}

export function DependabotPanel({ projectId }: DependabotPanelProps) {
  const [config, setConfig] = useState<DependabotConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/dependabot`)
      .then((r) => r.json())
      .then((data) => {
        setConfig(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-400 p-4">
        <span className="animate-spin">⟳</span> Loading Dependabot status…
      </div>
    );
  }

  if (!config?.managed) return null;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Dependabot Managed</h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            {config.owner}/{config.repo} · Updates handled via GitHub PRs
          </p>
        </div>
        <a
          href={`https://github.com/${config.owner}/${config.repo}/pulls?q=is%3Apr+is%3Aopen+author%3Aapp%2Fdependabot`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-orange-400 hover:text-orange-300 underline"
        >
          View on GitHub ↗
        </a>
      </div>

      {config.error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
          {config.error}
        </div>
      )}

      {!config.error && config.prs.length === 0 && (
        <div className="rounded-md bg-zinc-800/50 border border-zinc-700 px-3 py-2 text-xs text-zinc-400">
          No open Dependabot PRs — all up to date.
        </div>
      )}

      {config.prs.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-400">{config.prs.length} open PR{config.prs.length !== 1 ? 's' : ''}</p>
          <ul className="space-y-2">
            {config.prs.map((pr) => (
              <PRRow key={pr.number} pr={pr} />
            ))}
          </ul>
        </div>
      )}

      {config.fetchedAt && (
        <p className="text-xs text-zinc-600">
          Last fetched: {new Date(config.fetchedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

function PRRow({ pr }: { pr: DependabotPR }) {
  const mergeStatus = pr.mergeable === false
    ? { label: 'Conflict', color: 'text-red-400 bg-red-500/10 border-red-500/20' }
    : pr.mergeable === true
    ? { label: 'Mergeable', color: 'text-green-400 bg-green-500/10 border-green-500/20' }
    : { label: 'Checking', color: 'text-zinc-400 bg-zinc-800 border-zinc-700' };

  const updateLabel = pr.updateType.replace('version-update:semver-', '');

  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-zinc-700/50 bg-zinc-800/40 px-3 py-2">
      <div className="flex-1 min-w-0">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-zinc-200 hover:text-white truncate block"
        >
          #{pr.number} {pr.title}
        </a>
        <div className="flex items-center gap-2 mt-1">
          {pr.dependencyGroup && (
            <span className="text-xs text-zinc-500">Group: {pr.dependencyGroup}</span>
          )}
          {updateLabel && (
            <span className="text-xs text-zinc-500 capitalize">{updateLabel}</span>
          )}
        </div>
      </div>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${mergeStatus.color}`}>
        {mergeStatus.label}
      </span>
    </li>
  );
}
