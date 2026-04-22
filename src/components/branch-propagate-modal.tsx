'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { BranchSyncStatus, PropagationConfig } from '@/lib/types';

interface BranchPropagateModalProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

export function BranchPropagateModal({
  projectId,
  open,
  onClose,
}: BranchPropagateModalProps) {
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<BranchSyncStatus[]>([]);
  const [config, setConfig] = useState<PropagationConfig | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openPR, setOpenPR] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<BranchSyncStatus[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setResults(null);
    setSkipped([]);
    setFetchError(null);

    fetch(`/api/projects/${projectId}/branch-sync`)
      .then((r) => r.json())
      .then((data: { branches: BranchSyncStatus[]; config: PropagationConfig; error?: string }) => {
        if (data.error) {
          setFetchError(data.error);
          setLoading(false);
          return;
        }
        setBranches(data.branches);
        setConfig(data.config);
        setOpenPR(data.config.openPR);
        setSelected(new Set(data.branches.filter((b) => b.status === 'out_of_sync').map((b) => b.branch)));
        setLoading(false);
      })
      .catch((err) => {
        setFetchError(err instanceof Error ? err.message : 'Failed to load branch status');
        setLoading(false);
      });
  }, [open, projectId]);

  const toggleBranch = (branch: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(branch)) next.delete(branch);
      else next.add(branch);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/propagate-branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branches: Array.from(selected), openPR }),
      });
      const data = await res.json();
      setResults(data.results ?? []);
      setSkipped(data.skipped ?? []);
    } catch (err) {
      setResults([{
        branch: 'unknown',
        status: 'conflict',
        error: err instanceof Error ? err.message : 'Request failed',
      }]);
    } finally {
      setSubmitting(false);
    }
  };

  const outOfSync = branches.filter((b) => b.status === 'out_of_sync');
  const synced = branches.filter((b) => b.status === 'synced');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg bg-zinc-900 border-zinc-700">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Propagate Branch Dependencies</DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-zinc-400 py-4">
            <span className="animate-spin">⟳</span> Checking branch sync status…
          </div>
        )}

        {fetchError && (
          <div className="rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
            {fetchError}
          </div>
        )}

        {!loading && !fetchError && results === null && (
          <div className="space-y-4">
            {outOfSync.length === 0 ? (
              <p className="text-sm text-zinc-400">All active branches are in sync with main.</p>
            ) : (
              <>
                <p className="text-sm text-zinc-400">
                  Select branches to sync with main&apos;s <code className="text-zinc-300">package.json</code>:
                </p>
                <div className="space-y-2">
                  {outOfSync.map((b) => (
                    <label
                      key={b.branch}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border p-3 cursor-pointer',
                        selected.has(b.branch)
                          ? 'border-amber-500/30 bg-amber-500/5'
                          : 'border-zinc-700 bg-zinc-800/50'
                      )}
                    >
                      <Checkbox
                        checked={selected.has(b.branch)}
                        onCheckedChange={() => toggleBranch(b.branch)}
                      />
                      <span className="font-mono text-sm text-zinc-200">{b.branch}</span>
                      <Badge variant="outline" className="ml-auto text-xs border-amber-500/30 text-amber-400 bg-amber-500/10">
                        Out of sync
                      </Badge>
                    </label>
                  ))}
                </div>

                {synced.length > 0 && (
                  <p className="text-xs text-zinc-500">
                    {synced.length} branch{synced.length !== 1 ? 'es' : ''} already in sync: {synced.map((b) => b.branch).join(', ')}
                  </p>
                )}

                <div className="rounded-lg border border-zinc-700 p-3 space-y-2">
                  <p className="text-xs font-medium text-zinc-300">Delivery mode</p>
                  <div className="flex gap-3">
                    <label className={cn('flex items-center gap-2 text-sm cursor-pointer', openPR ? 'text-zinc-100' : 'text-zinc-500')}>
                      <input
                        type="radio"
                        checked={openPR}
                        onChange={() => setOpenPR(true)}
                        className="accent-amber-500"
                      />
                      Open PR per branch
                    </label>
                    <label className={cn('flex items-center gap-2 text-sm cursor-pointer', !openPR ? 'text-zinc-100' : 'text-zinc-500')}>
                      <input
                        type="radio"
                        checked={!openPR}
                        onChange={() => setOpenPR(false)}
                        className="accent-amber-500"
                      />
                      Push directly
                    </label>
                  </div>
                  {openPR && (
                    <p className="text-xs text-zinc-500">Requires GitHub token in Settings.</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {results !== null && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-zinc-300">Results</p>
            {results.map((r) => (
              <div
                key={r.branch}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-sm',
                  r.status === 'propagated'
                    ? 'border-green-500/20 bg-green-500/5'
                    : 'border-red-500/20 bg-red-500/5'
                )}
              >
                <span>{r.status === 'propagated' ? '✅' : '⚠️'}</span>
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-zinc-200">{r.branch}</span>
                  {r.status === 'propagated' && r.prUrl && (
                    <a
                      href={r.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-xs text-amber-400 hover:text-amber-300 underline mt-1"
                    >
                      View PR →
                    </a>
                  )}
                  {r.status === 'propagated' && !r.prUrl && (
                    <p className="text-xs text-green-400 mt-1">Pushed directly to branch</p>
                  )}
                  {r.status === 'conflict' && (
                    <p className="text-xs text-red-400 mt-1">{r.error}</p>
                  )}
                </div>
              </div>
            ))}
            {skipped.length > 0 && (
              <p className="text-xs text-zinc-500">
                Skipped (already in sync): {skipped.join(', ')}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {results === null ? (
            <>
              <Button variant="ghost" onClick={onClose} className="text-zinc-400">
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={submitting || selected.size === 0 || loading}
                className="bg-amber-600 hover:bg-amber-500 text-white"
              >
                {submitting ? 'Propagating…' : `Propagate ${selected.size > 0 ? `(${selected.size})` : ''}`}
              </Button>
            </>
          ) : (
            <Button onClick={onClose} className="bg-zinc-700 hover:bg-zinc-600 text-zinc-100">
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
