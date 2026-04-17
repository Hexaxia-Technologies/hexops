import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, statSync } from 'fs';
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
  PackageManager,
} from './types';
import {
  readProjectCache,
  writeProjectCache,
  createProjectCache,
  updateProjectPatchState,
  reconcilePatchHistory,
} from './patch-storage';
import { scanSpecVulnerabilities } from './spec-scanner';
import { checkLockFileFreshness } from './lockfile-checker';
import { hasDependabotConfig } from './dependabot-detector';

const execAsync = promisify(exec);

/**
 * Detect package manager for a project.
 *
 * Detection priority:
 * 1. Lock file (most recently modified wins)
 * 2. packageManager field in package.json
 * 3. Workspace config files (pnpm-workspace.yaml, .yarnrc.yml)
 * 4. .npmrc with pnpm-specific settings
 * 5. Falls back to npm (never returns null)
 */
export function detectPackageManager(projectPath: string): PackageManager {
  // Strategy 1: Check existing lock files (most recently modified wins)
  const locks = [
    { pm: 'pnpm' as const, file: 'pnpm-lock.yaml' },
    { pm: 'npm' as const, file: 'package-lock.json' },
    { pm: 'yarn' as const, file: 'yarn.lock' },
  ];

  const found = locks
    .map(l => {
      const p = join(projectPath, l.file);
      if (!existsSync(p)) return null;
      return { pm: l.pm, mtime: statSync(p).mtimeMs };
    })
    .filter(Boolean);

  if (found.length > 0) {
    return found.sort((a, b) => b!.mtime - a!.mtime)[0]!.pm;
  }

  // Strategy 2: Check packageManager field in package.json
  const pkgJsonPath = join(projectPath, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      if (typeof pkgJson.packageManager === 'string') {
        const pmName = pkgJson.packageManager.split('@')[0];
        if (pmName === 'pnpm') return 'pnpm';
        if (pmName === 'yarn') return 'yarn';
        if (pmName === 'npm') return 'npm';
      }
    } catch {
      // ignore parse errors
    }
  }

  // Strategy 3: Check for workspace config files
  if (existsSync(join(projectPath, 'pnpm-workspace.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, '.yarnrc.yml')) || existsSync(join(projectPath, '.yarnrc'))) return 'yarn';

  // Strategy 4: Check for .npmrc with pnpm-specific settings
  const npmrcPath = join(projectPath, '.npmrc');
  if (existsSync(npmrcPath)) {
    try {
      const npmrc = readFileSync(npmrcPath, 'utf-8');
      if (npmrc.includes('shamefully-hoist') || npmrc.includes('strict-peer-dependencies')) {
        return 'pnpm';
      }
    } catch {
      // ignore
    }
  }

  // Strategy 5: Default to npm
  return 'npm';
}

/**
 * Determine how the package manager was detected (for logging/UI)
 */
export function getDetectionSource(projectPath: string): 'lockfile' | 'packageJson' | 'workspaceConfig' | 'npmrc' | 'fallback' {
  const lockFiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];
  for (const lf of lockFiles) {
    if (existsSync(join(projectPath, lf))) return 'lockfile';
  }

  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.packageManager) return 'packageJson';
    } catch {}
  }

  if (existsSync(join(projectPath, 'pnpm-workspace.yaml'))) return 'workspaceConfig';
  if (existsSync(join(projectPath, '.yarnrc.yml')) || existsSync(join(projectPath, '.yarnrc'))) return 'workspaceConfig';

  const npmrcPath = join(projectPath, '.npmrc');
  if (existsSync(npmrcPath)) {
    try {
      const npmrc = readFileSync(npmrcPath, 'utf-8');
      if (npmrc.includes('shamefully-hoist') || npmrc.includes('strict-peer-dependencies')) return 'npmrc';
    } catch {}
  }

  return 'fallback';
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

    // Filter out packages where current version already matches latest
    // (can happen with workspace edge cases or lock file mismatches)
    return result.filter(pkg => {
      const current = pkg.current?.replace(/^[\^~]/, '');
      const latest = pkg.latest?.replace(/^[\^~]/, '');
      return current !== latest;
    });
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
        // A path like ".>next" means next is a direct dep of the root project (.)
        // Only treat as transitive if the chain has >1 real package (not just ".")
        const realParts = pathParts.filter(p => p !== '.');
        const isTransitive = realParts.length > 1;
        // Extract fix version from patched_versions (e.g., ">=16.1.5" -> "16.1.5")
        const fixVersion = adv.patched_versions?.match(/[\d.]+/)?.[0];
        const hasPatch = adv.patched_versions !== '<0.0.0';

        result.push({
          name: adv.module_name,
          severity: adv.severity as VulnSeverity,
          title: adv.title,
          path: depPath,
          // Transitive deps are always actionable via override
          fixAvailable: isTransitive ? true : hasPatch,
          fixVersion: isTransitive ? (fixVersion || 'resolve-latest') : fixVersion,
          currentVersion,
          isDirect: !isTransitive,
          via: isTransitive ? pathParts : undefined,
          parentPackage: isTransitive ? pathParts[0] : undefined,
          fixViaOverride: isTransitive || undefined,
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
          via: Array<string | { title?: string; source?: number; url?: string; cwe?: string[]; range?: string }>;
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

        // Determine fix availability and version
        let fixAvailable = !!vuln.fixAvailable;
        let fixVersion: string | undefined;
        let isBreakingFix = false;
        let fixViaOverride = false;
        let fixByParent: { name: string; version: string } | undefined;

        if (typeof vuln.fixAvailable === 'object') {
          isBreakingFix = vuln.fixAvailable.isSemVerMajor === true;

          if (vuln.isDirect || vuln.fixAvailable.name === name) {
            // Direct dep or self-referencing fix — update this package directly
            fixVersion = vuln.fixAvailable.version;
          } else if (!vuln.isDirect) {
            // Transitive dep — fixAvailable points to the parent package to update.
            // Preferred strategy: update the parent dependency directly.
            fixByParent = { name: vuln.fixAvailable.name, version: vuln.fixAvailable.version };
          }
        }

        // Direct deps: always allow patching — breaking updates show a warning but are still actionable
        if (vuln.isDirect) {
          if (!fixVersion && fixAvailable) {
            fixVersion = 'latest';
          }
        }

        // Transitive deps: determine fix strategy
        if (!vuln.isDirect && parentPackage) {
          if (fixByParent && !isBreakingFix) {
            // Best path: update the parent dependency (non-breaking)
            fixAvailable = true;
            fixVersion = fixByParent.version;
          } else {
            // Fallback: apply a package manager override for this package directly
            // Extract fix version from advisory range in via objects
            let overrideVersion: string | undefined;
            const viaAdvisories = vuln.via?.filter(v => typeof v === 'object' && v.range) as
              Array<{ range: string }> | undefined;

            if (viaAdvisories?.length) {
              const fixVersions: string[] = [];
              for (const adv of viaAdvisories) {
                const upperBounds = adv.range.match(/<(\d+\.\d+\.\d+)/g);
                if (upperBounds) {
                  for (const bound of upperBounds) {
                    fixVersions.push(bound.slice(1));
                  }
                }
              }

              if (fixVersions.length > 0 && currentVersion) {
                const currentMajor = parseInt(currentVersion.split('.')[0], 10);
                const sameMajorFix = fixVersions.find(v => parseInt(v.split('.')[0], 10) === currentMajor);
                overrideVersion = sameMajorFix || fixVersions[fixVersions.length - 1];
              } else if (fixVersions.length > 0) {
                overrideVersion = fixVersions[fixVersions.length - 1];
              }
            }

            fixAvailable = true;
            fixVersion = overrideVersion || 'resolve-latest';
            fixViaOverride = true;

            // If the parent update exists but is breaking, keep the reference for display
            if (fixByParent && isBreakingFix) {
              // fixByParent preserved so UI can show the alternative
            } else {
              fixByParent = undefined;
            }
          }
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
          parentAtLatest: isBreakingFix,
          fixViaOverride: fixViaOverride || undefined,
          fixByParent,
          isBreakingFix: isBreakingFix || undefined,
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

  // Detect dependabot management early (used to annotate scan results)
  const isManaged = hasDependabotConfig(project.path);

  // Run scans in parallel (spec scanner works without lock files)
  const [outdated, auditVulns, specVulns] = await Promise.all([
    scanOutdated(project),
    scanVulnerabilities(project),
    scanSpecVulnerabilities(project.path),
  ]);

  // Merge spec vulnerabilities with audit vulnerabilities, avoiding duplicates
  // A spec vuln is a duplicate if audit already found the same package+CVE
  const auditKeys = new Set(auditVulns.map(v => v.name));
  const uniqueSpecVulns = specVulns.filter(sv => !auditKeys.has(sv.name));
  const vulnerabilities = [...auditVulns, ...uniqueSpecVulns];

  // Check for stale lock files (will cause Vercel/CI deploy failures)
  const lockCheck = checkLockFileFreshness(project.path);
  if (!lockCheck.fresh) {
    for (const mismatch of lockCheck.mismatches) {
      vulnerabilities.push({
        name: mismatch.package,
        severity: 'info',
        title: `[Stale lockfile] spec ${mismatch.packageJsonSpec} but lock has ${mismatch.lockfileSpec} - run \`${lockCheck.lockfileType} install\` to fix`,
        path: mismatch.package,
        fixAvailable: true,
        fixVersion: mismatch.packageJsonSpec,
        currentVersion: `lock: ${mismatch.lockfileSpec}`,
        isDirect: true,
      });
    }
  }

  // Annotate results with dependabot management status
  const annotatedOutdated = outdated.map((pkg) => ({ ...pkg, dependabotManaged: isManaged }));
  const annotatedVulnerabilities = vulnerabilities.map((v) => ({ ...v, dependabotManaged: isManaged }));

  // Create and save cache
  const cache = createProjectCache(project.id, annotatedOutdated, annotatedVulnerabilities);
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

  // Reconcile patch history: check recent "success" entries against actual
  // installed versions to catch false positives from prior soft failures
  const installedVersions: Record<string, string> = {};
  for (const vuln of vulnerabilities) {
    if (vuln.currentVersion) installedVersions[vuln.name] = vuln.currentVersion;
  }
  for (const pkg of outdated) {
    if (pkg.current) installedVersions[pkg.name] = pkg.current;
  }
  if (Object.keys(installedVersions).length > 0) {
    const corrected = reconcilePatchHistory(project.id, installedVersions);
    if (corrected > 0) {
      console.log(`Reconciled ${corrected} false-success patch history entries for ${project.id}`);
    }
  }

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

    // Build a lookup from outdated packages for merging latest version info
    const outdatedByName = new Map(cache.outdated.map(pkg => [pkg.name, pkg]));

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

      // Use the latest available version from outdated data when it's newer than
      // the minimum vulnerability fix version, so the dashboard shows the best
      // upgrade target (e.g., 16.2.0) instead of just the minimum patch (16.1.7)
      const outdatedInfo = outdatedByName.get(packageName);
      const fixVersion = firstVuln.fixVersion || '';
      const latestVersion = outdatedInfo?.latest || '';
      const targetVersion = latestVersion && latestVersion !== fixVersion
        ? latestVersion
        : fixVersion;
      const updateType = firstVuln.currentVersion
        ? getUpdateType(firstVuln.currentVersion, targetVersion)
        : 'patch';

      queue.push({
        priority: getPriorityScore('vulnerability', highestSeverity),
        type: 'vulnerability',
        severity: highestSeverity as VulnSeverity,
        package: packageName,
        currentVersion: firstVuln.currentVersion || '',
        targetVersion,
        updateType,
        projectId: cache.projectId,
        projectName,
        title,
        fixAvailable: vulns.some(v => v.fixAvailable),
        fixViaOverride: vulns.some(v => v.fixViaOverride) || undefined,
        fixByParent: firstVuln.fixByParent,
        isBreakingFix: vulns.some(v => v.isBreakingFix) || undefined,
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

      // Skip packages where current version matches latest (no actual update)
      const cleanCurrent = pkg.current?.replace(/^[\^~]/, '');
      const cleanLatest = pkg.latest?.replace(/^[\^~]/, '');
      if (cleanCurrent && cleanLatest && cleanCurrent === cleanLatest) continue;

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
