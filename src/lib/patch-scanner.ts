import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
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
export function getUpdateType(current: string | undefined, target: string | undefined): UpdateType {
  if (!current || !target) return 'patch';

  const cleanCurrent = current.replace(/^[\^~]/, '');
  const cleanTarget = target.replace(/^[\^~]/, '');

  const [currMajor, currMinor] = cleanCurrent.split('.').map(Number);
  const [targMajor, targMinor] = cleanTarget.split('.').map(Number);

  if (isNaN(currMajor) || isNaN(targMajor)) return 'patch';
  if (targMajor > currMajor) return 'major';
  if (isNaN(currMinor) || isNaN(targMinor)) return 'patch';
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
      const { stdout } = await execAsync(cmd, { cwd: project.path, timeout: 30000 });
      output = stdout;
    } catch (err: unknown) {
      // These commands exit non-zero when outdated packages exist, or may timeout
      const execErr = err as { stdout?: string; killed?: boolean };
      if (execErr.killed) {
        console.warn(`Timeout scanning outdated for ${project.id}`);
        return [];
      }
      output = execErr.stdout || '{}';
    }

    // pnpm/npm may output warnings before JSON - extract only the JSON portion
    const jsonStart = output.search(/[\[{]/);
    const jsonOutput = jsonStart >= 0 ? output.slice(jsonStart) : '{}';
    const data = JSON.parse(jsonOutput);
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
    // npm format (object, or object with arrays for workspaces)
    else if (typeof data === 'object') {
      for (const [name, info] of Object.entries(data)) {
        // npm workspaces return an array of entries for each package
        // (one per workspace that has the dependency)
        if (Array.isArray(info)) {
          // Use the first entry - versions should be consistent across workspaces
          const first = info[0] as { current: string; wanted: string; latest: string; type?: string };
          if (first) {
            result.push({
              name,
              current: first.current,
              wanted: first.wanted,
              latest: first.latest,
              type: first.type === 'devDependencies' ? 'devDependencies' : 'dependencies',
            });
          }
        } else {
          // Standard npm format (single object per package)
          const pkg = info as { current: string; wanted: string; latest: string; type?: string };
          result.push({
            name,
            current: pkg.current,
            wanted: pkg.wanted,
            latest: pkg.latest,
            type: pkg.type === 'devDependencies' ? 'devDependencies' : 'dependencies',
          });
        }
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
      const { stdout } = await execAsync(cmd, { cwd: project.path, timeout: 30000 });
      output = stdout;
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; killed?: boolean };
      if (execErr.killed) {
        console.warn(`Timeout scanning vulnerabilities for ${project.id}`);
        return [];
      }
      output = execErr.stdout || '{}';
    }

    // pnpm/npm may output warnings before JSON - extract only the JSON portion
    const jsonStart = output.search(/[\[{]/);
    const jsonOutput = jsonStart >= 0 ? output.slice(jsonStart) : '{}';
    const data = JSON.parse(jsonOutput);
    const result: VulnerabilityInfo[] = [];

    // pnpm/npm advisories format
    if (data.advisories) {
      for (const advisory of Object.values(data.advisories)) {
        const adv = advisory as {
          module_name: string;
          severity: string;
          title: string;
          findings: Array<{ version?: string; paths: string[] }>;
          patched_versions: string;
          cves?: string[];
          url?: string;
          id?: number;
        };
        const depPath = adv.findings?.[0]?.paths?.[0] || adv.module_name;
        const pathParts = depPath.split('>').map(s => s.trim());
        const currentVersion = adv.findings?.[0]?.version;
        // Extract fix version from patched_versions (e.g., ">=16.1.5" -> "16.1.5")
        const fixVersion = adv.patched_versions?.match(/[\d.]+/)?.[0];
        result.push({
          name: adv.module_name,
          severity: adv.severity as VulnSeverity,
          title: adv.title,
          path: depPath,
          fixAvailable: adv.patched_versions !== '<0.0.0',
          fixVersion,
          currentVersion,
          isDirect: pathParts.length === 1,
          via: pathParts.length > 1 ? pathParts : undefined,
          parentPackage: pathParts.length > 1 ? pathParts[0] : undefined,
          cves: adv.cves?.length ? adv.cves : undefined,
          url: adv.url,
          advisoryId: adv.id,
        });
      }
    }

    // npm v7+ vulnerabilities format
    if (data.vulnerabilities) {
      for (const [name, info] of Object.entries(data.vulnerabilities)) {
        const vuln = info as {
          severity: string;
          via: Array<string | { title?: string; source?: number; url?: string; cwe?: string[] }>;
          fixAvailable: boolean | { name: string; version: string; isSemVerMajor?: boolean };
          isDirect: boolean;
          effects?: string[];
        };

        // Read installed version from node_modules when not provided in audit output
        let currentVersion: string | undefined;
        try {
          const pkgJsonPath = join(project.path, 'node_modules', name, 'package.json');
          if (existsSync(pkgJsonPath)) {
            const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
            currentVersion = pkgJson.version;
          }
        } catch { /* ignore - package may not be installed locally */ }

        // Extract title and advisory info from via (can be string or object with title)
        let title = 'Vulnerability';
        let advisoryId: number | undefined;
        let url: string | undefined;
        const viaWithTitle = vuln.via?.find(v => typeof v === 'object' && v.title);
        if (viaWithTitle && typeof viaWithTitle === 'object') {
          title = viaWithTitle.title || title;
          advisoryId = viaWithTitle.source;
          url = viaWithTitle.url || (advisoryId ? `https://github.com/advisories/GHSA-${advisoryId}` : undefined);
        }

        // Build dependency chain from via field
        const viaChain = vuln.via?.filter(v => typeof v === 'string') as string[];

        // Determine parent package (the direct dep that pulls in this transitive)
        // For transitive deps, the parent is in the effects chain or via chain
        let parentPackage: string | undefined;
        if (!vuln.isDirect && viaChain?.length > 0) {
          parentPackage = viaChain[0]; // First string in via is typically the parent
        }

        // Determine if fix is actually available and not destructive
        // - isSemVerMajor means the fix requires a breaking change
        // - If not a direct dependency and parent has the vuln, it's unfixable by user
        let fixAvailable = !!vuln.fixAvailable;
        let fixVersion: string | undefined;
        let isBreakingFix = false;

        if (typeof vuln.fixAvailable === 'object') {
          fixVersion = vuln.fixAvailable.version;
          isBreakingFix = vuln.fixAvailable.isSemVerMajor === true;
          // If the fix requires a breaking change, mark as unfixable (requires careful review)
          if (isBreakingFix) {
            fixAvailable = false;
          }
        }

        // When fixAvailable is boolean true but no version info, fall back to 'latest'
        if (!fixVersion && fixAvailable) {
          fixVersion = 'latest';
        }

        // Transitive deps where user can't directly fix are "unfixable"
        if (!vuln.isDirect && parentPackage) {
          // User can't directly fix transitive deps - parent package needs to update
          fixAvailable = false;
        }

        result.push({
          name,
          severity: vuln.severity as VulnSeverity,
          title,
          path: name,
          fixAvailable,
          fixVersion,
          currentVersion,
          isDirect: vuln.isDirect ?? true,
          via: viaChain?.length > 0 ? viaChain : undefined,
          parentPackage,
          parentAtLatest: isBreakingFix, // If breaking fix needed, parent is likely at latest
          advisoryId,
          url,
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
 * Creates one entry per project per package (1:1 relationship)
 */
export function buildPriorityQueue(
  caches: ProjectPatchCache[],
  projectMap: Record<string, string> = {},  // id -> name mapping
  holdsMap: Record<string, string[]> = {}   // id -> held package names
): { queue: PatchQueueItem[]; summary: PatchSummary } {
  const queue: PatchQueueItem[] = [];
  const summary: PatchSummary = {
    critical: 0,
    high: 0,
    moderate: 0,
    outdatedMajor: 0,
    outdatedMinor: 0,
    outdatedPatch: 0,
  };

  // Process each cache (one per project)
  for (const cache of caches) {
    const projectName = projectMap[cache.projectId] || cache.projectId;
    const projectHolds = holdsMap[cache.projectId] || [];

    // Deduplicate vulnerabilities by package name within project
    // Multiple advisories for same package get merged into one entry
    const vulnsByPackage = new Map<string, {
      vulns: typeof cache.vulnerabilities;
      highestSeverity: string;
      severityScore: number;
    }>();

    const severityOrder: Record<string, number> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

    for (const vuln of cache.vulnerabilities) {
      const existing = vulnsByPackage.get(vuln.name);
      const score = severityOrder[vuln.severity] ?? 0;

      if (!existing) {
        vulnsByPackage.set(vuln.name, {
          vulns: [vuln],
          highestSeverity: vuln.severity,
          severityScore: score,
        });
      } else {
        existing.vulns.push(vuln);
        if (score > existing.severityScore) {
          existing.highestSeverity = vuln.severity;
          existing.severityScore = score;
        }
      }
    }

    // Process deduplicated vulnerabilities
    for (const [packageName, data] of vulnsByPackage) {
      const { vulns, highestSeverity } = data;
      const firstVuln = vulns[0];
      const isHeld = projectHolds.includes(packageName);

      // Aggregate all CVEs from all advisories for this package
      const allCves = vulns.flatMap(v => v.cves || []).filter((cve, i, arr) => arr.indexOf(cve) === i);
      // Aggregate all advisory URLs
      const allUrls = vulns.map(v => v.url).filter(Boolean) as string[];
      // Build combined title showing vulnerability count
      const title = vulns.length === 1
        ? firstVuln.title
        : `${vulns.length} vulnerabilities: ${vulns.map(v => v.title).join('; ')}`;

      queue.push({
        priority: getPriorityScore('vulnerability', highestSeverity),
        type: 'vulnerability',
        severity: highestSeverity as VulnSeverity,
        package: packageName,
        currentVersion: firstVuln.currentVersion || '',
        targetVersion: firstVuln.fixVersion || '',
        updateType: 'patch',
        projectId: cache.projectId,
        projectName,
        title,
        fixAvailable: vulns.some(v => v.fixAvailable),
        isHeld,
        // Transitive dependency info (from first vuln)
        isDirect: firstVuln.isDirect,
        via: firstVuln.via,
        parentPackage: firstVuln.parentPackage,
        parentAtLatest: firstVuln.parentAtLatest,
        // Aggregated CVE/Advisory info
        cves: allCves.length > 0 ? allCves : undefined,
        url: allUrls[0], // Primary URL
        advisoryId: firstVuln.advisoryId,
      });

      // Update summary (count once per package, using highest severity)
      if (highestSeverity === 'critical') summary.critical++;
      else if (highestSeverity === 'high') summary.high++;
      else if (highestSeverity === 'moderate') summary.moderate++;
    }

    // Process outdated packages (skip if already covered by a vulnerability entry)
    for (const pkg of cache.outdated) {
      if (vulnsByPackage.has(pkg.name)) continue;

      const updateType = getUpdateType(pkg.current, pkg.latest);
      const isHeld = projectHolds.includes(pkg.name);

      queue.push({
        priority: getPriorityScore('outdated', updateType),
        type: 'outdated',
        severity: updateType,
        package: pkg.name,
        currentVersion: pkg.current,
        targetVersion: pkg.latest,
        updateType,
        projectId: cache.projectId,
        projectName,
        isHeld,
      });

      // Update summary (counts all occurrences)
      if (updateType === 'major') summary.outdatedMajor++;
      else if (updateType === 'minor') summary.outdatedMinor++;
      else summary.outdatedPatch++;
    }
  }

  // Sort by priority (lower number = higher priority)
  queue.sort((a, b) => a.priority - b.priority);

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
