import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import type { ProjectConfig, ProjectExtendedStatus } from './types';
import { getProcessInfo } from './process-manager';
import { auditCache } from '@/app/api/projects/[id]/package-health/route';

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

// Get outdated package count (cached, slower operation)
const packageStatusCache = new Map<string, { count: number; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getPackageStatus(path: string): Promise<ProjectExtendedStatus['packages'] | undefined> {
  // Check cache first
  const cached = packageStatusCache.get(path);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { outdatedCount: cached.count };
  }

  // Check for lockfiles to determine which package manager to use
  const hasPnpmLock = existsSync(join(path, 'pnpm-lock.yaml'));
  const hasNpmLock = existsSync(join(path, 'package-lock.json'));
  const hasYarnLock = existsSync(join(path, 'yarn.lock'));

  // No lockfile - can't check outdated packages
  if (!hasPnpmLock && !hasNpmLock && !hasYarnLock) {
    return undefined;
  }

  try {
    let stdout = '';

    if (hasPnpmLock) {
      try {
        const result = await execAsync('pnpm outdated --format json', {
          cwd: path,
          timeout: 10000
        });
        stdout = result.stdout;
      } catch (err: unknown) {
        // pnpm outdated exits with code 1 when outdated packages exist
        const execErr = err as { stdout?: string };
        stdout = execErr.stdout || '[]';
      }
    } else if (hasNpmLock) {
      try {
        const result = await execAsync('npm outdated --json', {
          cwd: path,
          timeout: 10000
        });
        stdout = result.stdout;
      } catch (err: unknown) {
        // npm outdated exits with code 1 when outdated packages exist
        const execErr = err as { stdout?: string };
        stdout = execErr.stdout || '{}';
      }
    } else {
      // yarn
      try {
        const result = await execAsync('yarn outdated --json', {
          cwd: path,
          timeout: 10000
        });
        stdout = result.stdout;
      } catch (err: unknown) {
        const execErr = err as { stdout?: string };
        stdout = execErr.stdout || '{}';
      }
    }

    let count = 0;
    try {
      const parsed = JSON.parse(stdout.trim() || '[]');
      count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
    } catch {
      count = 0;
    }

    packageStatusCache.set(path, { count, timestamp: Date.now() });
    return { outdatedCount: count };
  } catch {
    return undefined;
  }
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

  // Package status is slow - only include if requested and cached
  if (includePackages) {
    promises.push(
      getPackageStatus(project.path).then(packages => { extended.packages = packages; })
    );
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
