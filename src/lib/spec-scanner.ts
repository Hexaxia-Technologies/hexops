import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { VulnerabilityInfo, VulnSeverity } from './types';

interface AdvisoryResult {
  name: string;
  severity: VulnSeverity;
  title: string;
  cves: string[];
  url: string;
  vulnerableRange: string;
  patchedVersions: string;
}

interface NpmBulkAuditResponse {
  advisories?: Record<string, {
    module_name: string;
    severity: string;
    title: string;
    cves: string[];
    url: string;
    vulnerable_versions: string;
    patched_versions: string;
    id: number;
  }>;
  // npm v7+ format
  vulnerabilities?: Record<string, {
    severity: string;
    via: Array<string | {
      title?: string;
      source?: number;
      url?: string;
      range?: string;
      name?: string;
    }>;
    range?: string;
  }>;
}

/**
 * Parse a version spec to extract the minimum version it could resolve to.
 * Examples:
 *   "19.2.0" -> "19.2.0"
 *   "^19.2.0" -> "19.2.0"
 *   "~19.2.0" -> "19.2.0"
 *   "^19" -> "19.0.0"
 *   ">=19.0.0" -> "19.0.0"
 */
function getMinVersion(spec: string): string | null {
  const cleaned = spec.replace(/^[\^~>=]+/, '').trim();
  if (!cleaned) return null;

  const parts = cleaned.split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

/**
 * Check if a version string represents an exact pin (no range operator)
 */
function isExactPin(spec: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(spec.trim());
}

/**
 * Simple semver comparison: returns true if a < b
 */
function semverLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}

/**
 * Check if a version falls within a vulnerable range string.
 * Handles simple ranges like ">=19.0.0 <19.0.1 || >=19.1.0 <19.1.2 || >=19.2.0 <19.2.1"
 */
function isVersionInRange(version: string, range: string): boolean {
  // Split on || for multiple ranges
  const orClauses = range.split('||').map(s => s.trim());

  for (const clause of orClauses) {
    const conditions = clause.split(/\s+/).filter(Boolean);
    let matches = true;

    for (const cond of conditions) {
      const geMatch = cond.match(/^>=(\d+\.\d+\.\d+)$/);
      const ltMatch = cond.match(/^<(\d+\.\d+\.\d+)$/);
      const eqMatch = cond.match(/^(\d+\.\d+\.\d+)$/);

      if (geMatch) {
        if (semverLt(version, geMatch[1])) { matches = false; break; }
      } else if (ltMatch) {
        if (!semverLt(version, ltMatch[1])) { matches = false; break; }
      } else if (eqMatch) {
        if (version !== eqMatch[1]) { matches = false; break; }
      }
    }

    if (matches) return true;
  }

  return false;
}

/**
 * Scan package.json specs against npm advisory database.
 * This catches vulnerabilities that lock-file-based audit misses:
 * - Pinned versions that are vulnerable (e.g., "react": "19.2.0")
 * - Range specs where the minimum is vulnerable (e.g., "react": "^19.0.0")
 * - Projects without node_modules/lock files
 */
export async function scanSpecVulnerabilities(
  projectPath: string
): Promise<VulnerabilityInfo[]> {
  const pkgJsonPath = join(projectPath, 'package.json');
  if (!existsSync(pkgJsonPath)) return [];

  let pkgJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  } catch {
    return [];
  }

  const allDeps: Record<string, { spec: string; isDev: boolean }> = {};
  for (const [name, spec] of Object.entries(pkgJson.dependencies || {})) {
    allDeps[name] = { spec, isDev: false };
  }
  for (const [name, spec] of Object.entries(pkgJson.devDependencies || {})) {
    if (!allDeps[name]) allDeps[name] = { spec, isDev: true };
  }

  if (Object.keys(allDeps).length === 0) return [];

  // Query npm registry bulk advisory endpoint
  const advisories = await fetchAdvisories(allDeps);
  if (advisories.length === 0) return [];

  const results: VulnerabilityInfo[] = [];

  for (const advisory of advisories) {
    const dep = allDeps[advisory.name];
    if (!dep) continue;

    const minVersion = getMinVersion(dep.spec);
    if (!minVersion) continue;

    // Check if the minimum possible version falls in the vulnerable range
    const isVulnerable = isVersionInRange(minVersion, advisory.vulnerableRange);
    if (!isVulnerable) continue;

    // Check if there's an installed version that's already patched
    const installedVersion = getInstalledVersion(projectPath, advisory.name);
    if (installedVersion && !isVersionInRange(installedVersion, advisory.vulnerableRange)) {
      // Installed version is safe, but spec could still resolve to vulnerable on fresh install
      // Only flag exact pins since ranges will resolve to latest (safe) on fresh install
      if (!isExactPin(dep.spec)) continue;
    }

    const fixVersion = advisory.patchedVersions?.match(/[\d.]+/)?.[0];

    results.push({
      name: advisory.name,
      severity: advisory.severity,
      title: `[Spec] ${advisory.title}`,
      path: advisory.name,
      fixAvailable: !!fixVersion,
      fixVersion,
      currentVersion: installedVersion || `spec: ${dep.spec}`,
      isDirect: true,
      cves: advisory.cves.length > 0 ? advisory.cves : undefined,
      url: advisory.url,
    });
  }

  return results;
}

/**
 * Get installed version from node_modules
 */
function getInstalledVersion(projectPath: string, packageName: string): string | undefined {
  try {
    const pkgPath = join(projectPath, 'node_modules', packageName, 'package.json');
    if (existsSync(pkgPath)) {
      return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
    }
  } catch { /* not installed */ }
  return undefined;
}

/**
 * Fetch advisories from npm registry for a set of packages.
 * Uses the bulk advisory endpoint: POST /-/npm/v1/security/advisories/bulk
 */
async function fetchAdvisories(
  deps: Record<string, { spec: string; isDev: boolean }>
): Promise<AdvisoryResult[]> {
  // Build the request body that npm audit uses
  const body: Record<string, string[]> = {};
  for (const [name, { spec }] of Object.entries(deps)) {
    const minVer = getMinVersion(spec);
    if (minVer) {
      body[name] = [minVer];
    }
  }

  if (Object.keys(body).length === 0) return [];

  try {
    const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      // Fallback: try the quick audit endpoint
      return fetchAdvisoriesQuickAudit(deps);
    }

    const data = await response.json() as Record<string, Array<{
      id: number;
      title: string;
      severity: string;
      cves: string[];
      url: string;
      vulnerable_versions: string;
      patched_versions: string;
    }>>;

    const results: AdvisoryResult[] = [];
    for (const [name, advisories] of Object.entries(data)) {
      for (const adv of advisories) {
        results.push({
          name,
          severity: adv.severity as VulnSeverity,
          title: adv.title,
          cves: adv.cves || [],
          url: adv.url || `https://github.com/advisories/GHSA-${adv.id}`,
          vulnerableRange: adv.vulnerable_versions,
          patchedVersions: adv.patched_versions,
        });
      }
    }

    return results;
  } catch (error) {
    console.error('Failed to fetch npm advisories:', error);
    return [];
  }
}

/**
 * Fallback: use npm's quick audit endpoint
 */
async function fetchAdvisoriesQuickAudit(
  deps: Record<string, { spec: string; isDev: boolean }>
): Promise<AdvisoryResult[]> {
  const requires: Record<string, string> = {};
  const dependencies: Record<string, { version: string }> = {};

  for (const [name, { spec }] of Object.entries(deps)) {
    const minVer = getMinVersion(spec);
    if (minVer) {
      requires[name] = minVer;
      dependencies[name] = { version: minVer };
    }
  }

  try {
    const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/audits/quick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'hexops-spec-scan',
        version: '0.0.0',
        requires,
        dependencies,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return [];

    const data = await response.json() as NpmBulkAuditResponse;
    const results: AdvisoryResult[] = [];

    if (data.advisories) {
      for (const adv of Object.values(data.advisories)) {
        results.push({
          name: adv.module_name,
          severity: adv.severity as VulnSeverity,
          title: adv.title,
          cves: adv.cves || [],
          url: adv.url || `https://github.com/advisories/GHSA-${adv.id}`,
          vulnerableRange: adv.vulnerable_versions,
          patchedVersions: adv.patched_versions,
        });
      }
    }

    return results;
  } catch (error) {
    console.error('Failed to fetch quick audit:', error);
    return [];
  }
}
