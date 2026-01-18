import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import type {
  ProjectConfig,
  OutdatedPackage,
  VulnerabilityInfo,
  VulnSeverity,
  UpdateType,
  PatchQueueItem,
  PatchSummary,
  ProjectPatchCache,
} from './types';
import {
  readProjectCache,
  writeProjectCache,
  createProjectCache,
  updateProjectPatchState,
} from './patch-storage';

const execAsync = promisify(exec);

type PackageManager = 'pnpm' | 'npm' | 'yarn';

/**
 * Detect package manager from lockfile
 */
export function detectPackageManager(projectPath: string): PackageManager | null {
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'package-lock.json'))) return 'npm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  return null;
}

/**
 * Determine update type from version strings
 */
export function getUpdateType(current: string, target: string): UpdateType {
  const cleanCurrent = current.replace(/^[\^~]/, '');
  const cleanTarget = target.replace(/^[\^~]/, '');

  const [currMajor, currMinor] = cleanCurrent.split('.').map(Number);
  const [targMajor, targMinor] = cleanTarget.split('.').map(Number);

  if (targMajor > currMajor) return 'major';
  if (targMinor > currMinor) return 'minor';
  return 'patch';
}

/**
 * Scan a project for outdated packages
 */
export async function scanOutdated(
  project: ProjectConfig
): Promise<OutdatedPackage[]> {
  const pm = detectPackageManager(project.path);
  if (!pm) return [];

  try {
    let output = '';
    const cmd = pm === 'pnpm'
      ? 'pnpm outdated --format json'
      : pm === 'npm'
      ? 'npm outdated --json'
      : 'yarn outdated --json';

    try {
      const { stdout } = await execAsync(cmd, { cwd: project.path });
      output = stdout;
    } catch (err: unknown) {
      // These commands exit non-zero when outdated packages exist
      const execErr = err as { stdout?: string };
      output = execErr.stdout || '{}';
    }

    const data = JSON.parse(output || '{}');
    const result: OutdatedPackage[] = [];

    // pnpm format (array)
    if (Array.isArray(data)) {
      for (const pkg of data) {
        result.push({
          name: pkg.name,
          current: pkg.current,
          wanted: pkg.wanted,
          latest: pkg.latest,
          type: pkg.dependencyType === 'devDependencies' ? 'devDependencies' : 'dependencies',
        });
      }
    }
    // npm format (object)
    else if (typeof data === 'object') {
      for (const [name, info] of Object.entries(data)) {
        const pkg = info as { current: string; wanted: string; latest: string };
        result.push({
          name,
          current: pkg.current,
          wanted: pkg.wanted,
          latest: pkg.latest,
          type: 'dependencies', // npm doesn't distinguish in outdated output
        });
      }
    }

    return result;
  } catch (error) {
    console.error(`Failed to scan outdated for ${project.id}:`, error);
    return [];
  }
}

/**
 * Scan a project for vulnerabilities
 */
export async function scanVulnerabilities(
  project: ProjectConfig
): Promise<VulnerabilityInfo[]> {
  const pm = detectPackageManager(project.path);
  if (!pm) return [];

  try {
    let output = '';
    const cmd = pm === 'pnpm'
      ? 'pnpm audit --json'
      : pm === 'npm'
      ? 'npm audit --json'
      : 'yarn audit --json';

    try {
      const { stdout } = await execAsync(cmd, { cwd: project.path });
      output = stdout;
    } catch (err: unknown) {
      const execErr = err as { stdout?: string };
      output = execErr.stdout || '{}';
    }

    const data = JSON.parse(output || '{}');
    const result: VulnerabilityInfo[] = [];

    // pnpm/npm advisories format
    if (data.advisories) {
      for (const advisory of Object.values(data.advisories)) {
        const adv = advisory as {
          module_name: string;
          severity: string;
          title: string;
          findings: Array<{ paths: string[] }>;
          patched_versions: string;
        };
        result.push({
          name: adv.module_name,
          severity: adv.severity as VulnSeverity,
          title: adv.title,
          path: adv.findings?.[0]?.paths?.[0] || adv.module_name,
          fixAvailable: adv.patched_versions !== '<0.0.0',
        });
      }
    }

    // npm v7+ vulnerabilities format
    if (data.vulnerabilities) {
      for (const [name, info] of Object.entries(data.vulnerabilities)) {
        const vuln = info as {
          severity: string;
          via: Array<{ title?: string }>;
          fixAvailable: boolean | { name: string; version: string };
        };
        result.push({
          name,
          severity: vuln.severity as VulnSeverity,
          title: vuln.via?.[0]?.title || 'Vulnerability',
          path: name,
          fixAvailable: !!vuln.fixAvailable,
          fixVersion: typeof vuln.fixAvailable === 'object'
            ? vuln.fixAvailable.version
            : undefined,
        });
      }
    }

    return result;
  } catch (error) {
    console.error(`Failed to scan vulnerabilities for ${project.id}:`, error);
    return [];
  }
}

/**
 * Scan a project (uses cache if valid)
 */
export async function scanProject(
  project: ProjectConfig,
  forceRefresh = false
): Promise<ProjectPatchCache> {
  // Check cache first
  if (!forceRefresh) {
    const cached = readProjectCache(project.id);
    if (cached) return cached;
  }

  // Run scans in parallel
  const [outdated, vulnerabilities] = await Promise.all([
    scanOutdated(project),
    scanVulnerabilities(project),
  ]);

  // Create and save cache
  const cache = createProjectCache(project.id, outdated, vulnerabilities);
  writeProjectCache(cache);

  // Update aggregate state
  updateProjectPatchState(project.id, {
    outdatedCount: outdated.length,
    vulnCount: vulnerabilities.length,
    criticalCount: vulnerabilities.filter(
      v => v.severity === 'critical' || v.severity === 'high'
    ).length,
    lastChecked: cache.timestamp,
  });

  return cache;
}

/**
 * Build priority queue from multiple project caches
 */
export function buildPriorityQueue(
  caches: ProjectPatchCache[]
): { queue: PatchQueueItem[]; summary: PatchSummary } {
  const packageMap = new Map<string, PatchQueueItem>();
  const summary: PatchSummary = {
    critical: 0,
    high: 0,
    moderate: 0,
    outdatedMajor: 0,
    outdatedMinor: 0,
    outdatedPatch: 0,
  };

  // Process vulnerabilities first (higher priority)
  for (const cache of caches) {
    for (const vuln of cache.vulnerabilities) {
      const key = `vuln:${vuln.name}:${vuln.severity}`;
      const existing = packageMap.get(key);

      if (existing) {
        if (!existing.affectedProjects.includes(cache.projectId)) {
          existing.affectedProjects.push(cache.projectId);
        }
      } else {
        packageMap.set(key, {
          priority: getPriorityScore('vulnerability', vuln.severity),
          type: 'vulnerability',
          severity: vuln.severity,
          package: vuln.name,
          currentVersion: '',
          targetVersion: vuln.fixVersion || '',
          updateType: 'patch',
          affectedProjects: [cache.projectId],
          title: vuln.title,
          fixAvailable: vuln.fixAvailable,
        });

        // Update summary
        if (vuln.severity === 'critical') summary.critical++;
        else if (vuln.severity === 'high') summary.high++;
        else if (vuln.severity === 'moderate') summary.moderate++;
      }
    }

    // Process outdated packages
    for (const pkg of cache.outdated) {
      const updateType = getUpdateType(pkg.current, pkg.latest);
      const key = `outdated:${pkg.name}:${pkg.latest}`;
      const existing = packageMap.get(key);

      if (existing) {
        if (!existing.affectedProjects.includes(cache.projectId)) {
          existing.affectedProjects.push(cache.projectId);
        }
      } else {
        packageMap.set(key, {
          priority: getPriorityScore('outdated', updateType),
          type: 'outdated',
          severity: updateType,
          package: pkg.name,
          currentVersion: pkg.current,
          targetVersion: pkg.latest,
          updateType,
          affectedProjects: [cache.projectId],
        });

        // Update summary
        if (updateType === 'major') summary.outdatedMajor++;
        else if (updateType === 'minor') summary.outdatedMinor++;
        else summary.outdatedPatch++;
      }
    }
  }

  // Sort by priority (lower number = higher priority)
  const queue = Array.from(packageMap.values()).sort(
    (a, b) => a.priority - b.priority
  );

  return { queue, summary };
}

/**
 * Get priority score (lower = more urgent)
 */
function getPriorityScore(
  type: 'vulnerability' | 'outdated',
  severity: string
): number {
  if (type === 'vulnerability') {
    switch (severity) {
      case 'critical': return 1;
      case 'high': return 2;
      case 'moderate': return 3;
      case 'low': return 4;
      default: return 5;
    }
  }
  // Outdated
  switch (severity) {
    case 'major': return 10;
    case 'minor': return 20;
    default: return 30;
  }
}
