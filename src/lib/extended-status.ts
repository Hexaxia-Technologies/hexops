import { exec } from 'child_process';
import { promisify } from 'util';
import type { ProjectConfig, ProjectExtendedStatus } from './types';
import { getProcessInfo } from './process-manager';
import { auditCache } from '@/app/api/projects/[id]/package-health/route';
import { readProjectCache } from './patch-storage';

const execAsync = promisify(exec);

// Get git status (branch + dirty) for a project
async function getGitStatus(path: string): Promise<ProjectExtendedStatus['git'] | undefined> {
  try {
    // Check if git repo
    await execAsync('git rev-parse --git-dir', { cwd: path, timeout: 2000 });

    // Get branch and status in parallel
    const [branchResult, statusResult] = await Promise.all([
      execAsync('git branch --show-current', { cwd: path, timeout: 2000 }),
      execAsync('git status --porcelain', { cwd: path, timeout: 2000 }),
    ]);

    return {
      branch: branchResult.stdout.trim() || 'detached',
      dirty: statusResult.stdout.trim().length > 0,
    };
  } catch {
    return undefined;
  }
}

// Get metrics for a running process by port
async function getProcessMetrics(port: number, projectId: string): Promise<ProjectExtendedStatus['metrics'] | undefined> {
  try {
    // Try internal tracking first
    const processInfo = getProcessInfo(projectId);
    let pid: number | null = processInfo?.pid ?? null;

    // If not tracked, find PID from port
    if (!pid) {
      const { stdout } = await execAsync(`ss -tlnp sport = :${port}`, { timeout: 2000 });
      const pidMatch = stdout.match(/pid=(\d+)/);
      if (pidMatch) {
        pid = parseInt(pidMatch[1]);
      }
    }

    if (!pid) return undefined;

    // Get process stats
    const { stdout } = await execAsync(
      `ps -p ${pid} -o etime,rss --no-headers`,
      { timeout: 2000 }
    );

    if (stdout.trim()) {
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 2) {
        return {
          pid,
          uptime: parseElapsedTime(parts[0]) * 1000, // convert to ms
          memory: Math.round(parseInt(parts[1]) / 1024), // convert to MB
        };
      }
    }

    return { pid, uptime: 0, memory: 0 };
  } catch {
    return undefined;
  }
}

// Parse ps elapsed time format: [[DD-]HH:]MM:SS to seconds
function parseElapsedTime(etime: string): number {
  let seconds = 0;
  let parts = etime.split('-');

  if (parts.length === 2) {
    seconds += parseInt(parts[0]) * 86400;
    etime = parts[1];
  } else {
    etime = parts[0];
  }

  parts = etime.split(':');
  if (parts.length === 3) {
    seconds += parseInt(parts[0]) * 3600;
    seconds += parseInt(parts[1]) * 60;
    seconds += parseInt(parts[2]);
  } else if (parts.length === 2) {
    seconds += parseInt(parts[0]) * 60;
    seconds += parseInt(parts[1]);
  }

  return seconds;
}

// Cache TTL for vulnerability data from audit endpoint
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Invalidate package status cache for a project
 * @deprecated Cache is now managed by patch-storage.ts - use invalidateProjectCache instead
 */
export function invalidatePackageStatusCache(_path: string): void {
  // No-op - cache is now managed by patch-storage.ts
}

/**
 * Invalidate package status cache for all projects
 * @deprecated Cache is now managed by patch-storage.ts
 */
export function invalidateAllPackageStatusCache(): void {
  // No-op - cache is now managed by patch-storage.ts
}

/**
 * Get package status from unified patch cache
 * Returns outdated count and held count from the patch scanner cache (single source of truth)
 */
function getPackageStatus(projectId: string, holds: string[] = []): ProjectExtendedStatus['packages'] | undefined {
  // Read from unified patch cache (managed by patch-scanner.ts)
  const cache = readProjectCache(projectId);
  if (!cache) {
    // Cache missing or expired - return undefined (dashboard will show '-')
    return undefined;
  }

  // Calculate how many outdated packages are held
  const heldCount = cache.outdated.filter(pkg => holds.includes(pkg.name)).length;

  return {
    outdatedCount: cache.outdated.length,
    heldCount,
  };
}

// Get vulnerability counts from audit cache
function getVulnerabilityCounts(projectId: string): { total: number; critical: number } | undefined {
  const auditData = auditCache.get(projectId);
  if (!auditData || Date.now() - auditData.timestamp >= CACHE_TTL) {
    return undefined;
  }

  const vulnerabilities = auditData.data as Array<{ severity: string }>;
  if (!Array.isArray(vulnerabilities)) {
    return undefined;
  }

  const critical = vulnerabilities.filter(
    v => v.severity === 'critical' || v.severity === 'high'
  ).length;

  return { total: vulnerabilities.length, critical };
}

// Fetch extended status for a single project
export async function getExtendedStatus(
  project: ProjectConfig,
  isRunning: boolean,
  includePackages: boolean = false
): Promise<ProjectExtendedStatus> {
  const extended: ProjectExtendedStatus = {};

  // Run git check (fast) and optionally package checks (slow)
  // Only get metrics if running
  const promises: Promise<void>[] = [
    getGitStatus(project.path).then(git => { extended.git = git; }),
  ];

  // Package status - read from unified patch cache (synchronous)
  if (includePackages) {
    extended.packages = getPackageStatus(project.id, project.holds || []);
  }

  if (isRunning) {
    promises.push(
      getProcessMetrics(project.port, project.id).then(metrics => { extended.metrics = metrics; })
    );
  }

  await Promise.all(promises);

  // Add vulnerability data from audit cache if available
  const vulnCounts = getVulnerabilityCounts(project.id);
  if (vulnCounts && extended.packages) {
    extended.packages.vulnerabilityCount = vulnCounts.total;
    extended.packages.criticalVulnerabilityCount = vulnCounts.critical;
  } else if (vulnCounts) {
    extended.packages = {
      outdatedCount: 0,
      vulnerabilityCount: vulnCounts.total,
      criticalVulnerabilityCount: vulnCounts.critical,
    };
  }

  return extended;
}

// Fetch extended status for multiple projects in parallel
export async function getExtendedStatusBatch(
  projects: Array<{ config: ProjectConfig; isRunning: boolean }>,
  includePackages: boolean = false
): Promise<Map<string, ProjectExtendedStatus>> {
  const results = new Map<string, ProjectExtendedStatus>();

  await Promise.all(
    projects.map(async ({ config, isRunning }) => {
      const status = await getExtendedStatus(config, isRunning, includePackages);
      results.set(config.id, status);
    })
  );

  return results;
}
