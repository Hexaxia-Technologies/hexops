'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, CheckCircle, Package, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PackageHealthSectionProps {
  projectId: string;
  projectPath: string;
  projectName: string;
  initialOutdatedCount?: number;
  onOpenPanel?: (
    projectId: string,
    projectName: string,
    subType: 'outdated' | 'audit',
    rawOutput: string
  ) => void;
}

interface Dependency {
  name: string;
  current: string;
  wanted?: string;
  latest?: string;
  isOutdated: boolean;
}

interface Vulnerability {
  name: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  path: string;
  fixAvailable: boolean;
}

interface PackageHealth {
  dependencies: Dependency[];
  devDependencies: Dependency[];
  vulnerabilities: Vulnerability[];
  lastAuditDate?: string;
}

export function PackageHealthSection({ projectId, projectName, initialOutdatedCount, onOpenPanel }: PackageHealthSectionProps) {
  const [health, setHealth] = useState<PackageHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [auditing, setAuditing] = useState(false);
  const [checkingOutdated, setCheckingOutdated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/package-health`);
      if (!res.ok) throw new Error('Failed to fetch package health');
      const data = await res.json();
      setHealth(data);
      setError(null);
    } catch (err) {
      setError('Could not load package health');
      console.error('Failed to fetch package health:', err);
    } finally {
      setLoading(false);
    }
  };

  const runAudit = async () => {
    setAuditing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/audit`, { method: 'POST' });
      if (!res.ok) throw new Error('Audit failed');
      const data = await res.json();
      await fetchHealth();
      // Open the sidebar panel with raw output
      if (onOpenPanel && data.rawOutput) {
        onOpenPanel(projectId, projectName, 'audit', data.rawOutput);
      }
    } catch (err) {
      console.error('Failed to run audit:', err);
    } finally {
      setAuditing(false);
    }
  };

  const checkOutdated = async () => {
    setCheckingOutdated(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/outdated`, { method: 'POST' });
      if (!res.ok) throw new Error('Outdated check failed');
      const data = await res.json();
      await fetchHealth();
      // Open the sidebar panel with raw output
      if (onOpenPanel && data.rawOutput) {
        onOpenPanel(projectId, projectName, 'outdated', data.rawOutput);
      }
    } catch (err) {
      console.error('Failed to check outdated:', err);
    } finally {
      setCheckingOutdated(false);
    }
  };

  useEffect(() => {
    fetchHealth();
  }, [projectId]);

  if (loading) {
    return <div className="text-zinc-500 text-sm">Loading package health...</div>;
  }

  if (error || !health) {
    return <div className="text-red-400 text-sm">{error || 'No package health data available'}</div>;
  }

  // Use fetched count, or fall back to initial count from dashboard
  const fetchedOutdatedCount = [...health.dependencies, ...health.devDependencies].filter(d => d.isOutdated).length;
  const outdatedCount = fetchedOutdatedCount > 0 ? fetchedOutdatedCount : (initialOutdatedCount ?? 0);
  const criticalVulns = health.vulnerabilities.filter(v => v.severity === 'critical' || v.severity === 'high').length;

  return (
    <div className="space-y-4">
      {/* Summary & Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-zinc-500" />
            <span className="text-sm text-zinc-300">
              {health.dependencies.length + health.devDependencies.length} packages
            </span>
          </div>

          {outdatedCount > 0 && (
            <Badge variant="outline" className="text-xs border-yellow-500/50 text-yellow-400">
              {outdatedCount} outdated
            </Badge>
          )}

          {criticalVulns > 0 ? (
            <Badge variant="outline" className="text-xs border-red-500/50 text-red-400">
              <ShieldAlert className="h-3 w-3 mr-1" />
              {criticalVulns} critical/high
            </Badge>
          ) : health.vulnerabilities.length === 0 ? (
            <Badge variant="outline" className="text-xs border-green-500/50 text-green-400">
              <CheckCircle className="h-3 w-3 mr-1" />
              No vulnerabilities
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs border-yellow-500/50 text-yellow-400">
              {health.vulnerabilities.length} vulnerabilities
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-zinc-400"
            onClick={checkOutdated}
            disabled={checkingOutdated}
          >
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1', checkingOutdated && 'animate-spin')} />
            Check Updates
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-zinc-400"
            onClick={runAudit}
            disabled={auditing}
          >
            <ShieldAlert className={cn('h-3.5 w-3.5 mr-1', auditing && 'animate-spin')} />
            Run Audit
          </Button>
        </div>
      </div>

      {/* Vulnerabilities */}
      {health.vulnerabilities.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Vulnerabilities</h4>
          <div className="space-y-1">
            {health.vulnerabilities.map((vuln, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2 px-3 bg-zinc-900 rounded text-sm"
              >
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={vuln.severity} />
                  <span className="font-mono text-zinc-300">{vuln.name}</span>
                  <span className="text-zinc-500 truncate max-w-[200px]">{vuln.title}</span>
                </div>
                {vuln.fixAvailable && (
                  <Badge variant="outline" className="text-xs border-green-500/50 text-green-400">
                    Fix available
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dependencies */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          Dependencies ({health.dependencies.length})
        </h4>
        <div className="max-h-48 overflow-auto">
          <DependencyList deps={health.dependencies} />
        </div>
      </div>

      {/* Dev Dependencies */}
      {health.devDependencies.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
            Dev Dependencies ({health.devDependencies.length})
          </h4>
          <div className="max-h-48 overflow-auto">
            <DependencyList deps={health.devDependencies} />
          </div>
        </div>
      )}
    </div>
  );
}

function DependencyList({ deps }: { deps: Dependency[] }) {
  if (deps.length === 0) {
    return <p className="text-zinc-500 text-sm">No dependencies</p>;
  }

  return (
    <div className="space-y-1">
      {deps.map((dep) => (
        <div
          key={dep.name}
          className="flex items-center justify-between py-1.5 px-3 bg-zinc-900 rounded text-sm"
        >
          <span className="font-mono text-zinc-300">{dep.name}</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-zinc-500">{dep.current}</span>
            {dep.isOutdated && dep.latest && (
              <>
                <span className="text-zinc-600">→</span>
                <span className="font-mono text-green-400">{dep.latest}</span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: Vulnerability['severity'] }) {
  const styles = {
    critical: 'bg-red-500/20 text-red-400 border-red-500/50',
    high: 'bg-orange-500/20 text-orange-400 border-orange-500/50',
    moderate: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
    low: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
    info: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/50',
  };

  return (
    <Badge variant="outline" className={cn('text-xs uppercase', styles[severity])}>
      {severity}
    </Badge>
  );
}
