'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { RefreshCw, ArrowLeft, Shield, Package, ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PatchQueueItem, PatchSummary } from '@/lib/types';
import Link from 'next/link';

interface PatchesData {
  queue: PatchQueueItem[];
  summary: PatchSummary;
  lastScan: string | null;
  projectCount: number;
}

type FilterType = 'all' | 'vulns' | 'outdated';

export default function PatchesPage() {
  const [data, setData] = useState<PatchesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState(false);

  const fetchPatches = useCallback(async () => {
    try {
      const res = await fetch('/api/patches');
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await res.json();
      setData(json);
    } catch (error) {
      console.error('Failed to fetch patches:', error);
      toast.error('Failed to load patch data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPatches();
  }, [fetchPatches]);

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/patches/scan', { method: 'POST' });
      if (!res.ok) throw new Error('Scan failed');
      const json = await res.json();
      setData(json);
      toast.success('Scan complete');
    } catch (error) {
      console.error('Scan failed:', error);
      toast.error('Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const toggleSelection = (key: string) => {
    setSelectedPackages(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const filteredQueue = data?.queue.filter(item => {
    if (filter === 'vulns') return item.type === 'vulnerability';
    if (filter === 'outdated') return item.type === 'outdated';
    return true;
  }) || [];

  const selectAll = () => {
    const keys = filteredQueue.map(item => `${item.type}:${item.package}:${item.targetVersion}`);
    setSelectedPackages(new Set(keys));
  };

  const clearSelection = () => {
    setSelectedPackages(new Set());
  };

  const handleUpdateSelected = async () => {
    if (!data || selectedPackages.size === 0) return;

    setUpdating(true);
    const selectedItems = filteredQueue.filter(
      item => selectedPackages.has(`${item.type}:${item.package}:${item.targetVersion}`)
    );

    // Group by project for batch updates
    const updatesByProject = new Map<string, Array<{ name: string; toVersion: string; fromVersion: string }>>();

    for (const item of selectedItems) {
      for (const projectId of item.affectedProjects) {
        if (!updatesByProject.has(projectId)) {
          updatesByProject.set(projectId, []);
        }
        updatesByProject.get(projectId)!.push({
          name: item.package,
          toVersion: item.targetVersion,
          fromVersion: item.currentVersion,
        });
      }
    }

    let successCount = 0;
    let failCount = 0;

    for (const [projectId, packages] of updatesByProject) {
      try {
        const res = await fetch(`/api/projects/${projectId}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packages }),
        });
        const result = await res.json();
        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    setUpdating(false);
    setSelectedPackages(new Set());

    if (failCount === 0) {
      toast.success(`Updated packages in ${successCount} project(s)`);
    } else {
      toast.warning(`${successCount} succeeded, ${failCount} failed`);
    }

    // Refresh data
    fetchPatches();
  };

  if (loading) {
    return (
      <div className="flex h-screen bg-zinc-950 items-center justify-center">
        <div className="text-zinc-500">Loading patch data...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-screen bg-zinc-950 items-center justify-center">
        <div className="text-red-400">Failed to load patch data</div>
      </div>
    );
  }

  const { summary } = data;
  const totalIssues = summary.critical + summary.high + summary.moderate +
    summary.outdatedMajor + summary.outdatedMinor + summary.outdatedPatch;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="sm" className="text-zinc-400">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Dashboard
              </Button>
            </Link>
            <h1 className="text-xl font-semibold">Patches</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500">
              {data.lastScan
                ? `Last scan: ${new Date(data.lastScan).toLocaleString()}`
                : 'Never scanned'}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="border-zinc-700"
              onClick={handleScan}
              disabled={scanning}
            >
              <RefreshCw className={cn('h-4 w-4 mr-2', scanning && 'animate-spin')} />
              {scanning ? 'Scanning...' : 'Scan All'}
            </Button>
          </div>
        </div>
      </header>

      {/* Summary Bar */}
      <div className="border-b border-zinc-800 px-6 py-3 bg-zinc-900/50">
        <div className="flex items-center gap-6">
          {summary.critical > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-sm text-red-400">{summary.critical} critical</span>
            </div>
          )}
          {summary.high > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-orange-500" />
              <span className="text-sm text-orange-400">{summary.high} high</span>
            </div>
          )}
          {summary.outdatedMajor > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-yellow-500" />
              <span className="text-sm text-yellow-400">{summary.outdatedMajor} major</span>
            </div>
          )}
          {(summary.outdatedMinor + summary.outdatedPatch) > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-zinc-500" />
              <span className="text-sm text-zinc-400">
                {summary.outdatedMinor + summary.outdatedPatch} minor/patch
              </span>
            </div>
          )}
          {totalIssues === 0 && (
            <span className="text-sm text-green-400">All packages up to date!</span>
          )}
        </div>
      </div>

      {/* Filters & Actions */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 mr-2">Filter:</span>
          <Button
            variant={filter === 'all' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setFilter('all')}
          >
            All ({data.queue.length})
          </Button>
          <Button
            variant={filter === 'vulns' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setFilter('vulns')}
          >
            <Shield className="h-3 w-3 mr-1" />
            Vulnerabilities
          </Button>
          <Button
            variant={filter === 'outdated' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setFilter('outdated')}
          >
            <Package className="h-3 w-3 mr-1" />
            Outdated
          </Button>
        </div>

        {selectedPackages.size > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400">{selectedPackages.size} selected</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-zinc-400"
              onClick={clearSelection}
            >
              Clear
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs bg-purple-600 hover:bg-purple-700"
              onClick={handleUpdateSelected}
              disabled={updating}
            >
              <ArrowUp className={cn('h-3 w-3 mr-1', updating && 'animate-bounce')} />
              {updating ? 'Updating...' : 'Update Selected'}
            </Button>
          </div>
        )}

        {selectedPackages.size === 0 && filteredQueue.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-zinc-400"
            onClick={selectAll}
          >
            Select All
          </Button>
        )}
      </div>

      {/* Queue List */}
      <div className="p-6 space-y-2">
        {filteredQueue.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            {filter === 'all'
              ? 'No patches needed — all packages are up to date!'
              : `No ${filter === 'vulns' ? 'vulnerabilities' : 'outdated packages'} found`}
          </div>
        ) : (
          filteredQueue.map((item, index) => {
            const key = `${item.type}:${item.package}:${item.severity}:${item.targetVersion || index}`;
            const isSelected = selectedPackages.has(key);

            return (
              <div
                key={key}
                className={cn(
                  'flex items-center gap-4 p-4 rounded-lg border transition-colors cursor-pointer',
                  isSelected
                    ? 'bg-purple-500/10 border-purple-500/30'
                    : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700'
                )}
                onClick={() => toggleSelection(key)}
              >
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => toggleSelection(key)}
                />

                <SeverityBadge type={item.type} severity={item.severity} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{item.package}</span>
                    {item.currentVersion && (
                      <>
                        <span className="text-zinc-500 font-mono text-sm">
                          {item.currentVersion}
                        </span>
                        <span className="text-zinc-600">→</span>
                        <span className="text-green-400 font-mono text-sm">
                          {item.targetVersion}
                        </span>
                      </>
                    )}
                    <Badge variant="outline" className="text-xs border-zinc-700 text-zinc-500">
                      {item.updateType}
                    </Badge>
                  </div>
                  {item.title && (
                    <p className="text-sm text-zinc-500 truncate mt-1">{item.title}</p>
                  )}
                  <p className="text-xs text-zinc-600 mt-1">
                    Affects: {item.affectedProjects.join(', ')}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function SeverityBadge({ type, severity }: { type: string; severity: string }) {
  if (type === 'vulnerability') {
    const styles: Record<string, string> = {
      critical: 'bg-red-500/20 text-red-400 border-red-500/50',
      high: 'bg-orange-500/20 text-orange-400 border-orange-500/50',
      moderate: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
      low: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
      info: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/50',
    };
    return (
      <Badge variant="outline" className={cn('text-xs uppercase w-20 justify-center', styles[severity])}>
        {severity}
      </Badge>
    );
  }

  // Outdated
  const styles: Record<string, string> = {
    major: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
    minor: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
    patch: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/50',
  };
  return (
    <Badge variant="outline" className={cn('text-xs uppercase w-20 justify-center', styles[severity])}>
      {severity}
    </Badge>
  );
}
