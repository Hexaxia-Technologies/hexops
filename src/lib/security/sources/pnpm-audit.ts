import type { ScanSource, Finding, Severity, ScanSourceResult } from '../types';
import type { ProjectConfig, VulnerabilityInfo } from '../../types';
import { runPnpmAudit } from '../../patch-scanner';
import { existsSync } from 'fs';
import { join } from 'path';

const SEVERITY_MAP: Record<string, Severity> = {
  critical: 'critical',
  high: 'high',
  moderate: 'medium',
  medium: 'medium',
  low: 'low',
  info: 'info',
};

const GHSA_RE = /GHSA-[0-9a-z-]+/i;

function detectPm(projectPath: string): 'pnpm' | 'npm' | null {
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'package-lock.json'))) return 'npm';
  return null;
}

/**
 * Maps a VulnerabilityInfo record (from runPnpmAudit) to a security Finding.
 * Exported for unit-testing without requiring I/O.
 *
 * Advisory ID strategy:
 *   1. Include all CVEs from v.cves (pnpm audit output)
 *   2. Extract a GHSA id from v.url via regex (npm audit exposes it only in the URL)
 *   3. Include the numeric npm advisoryId as a string
 *   4. Deduplicate the resulting list
 */
export function vulnInfoToFinding(v: VulnerabilityInfo): Finding {
  const raw: string[] = [
    ...(v.cves ?? []),
  ];

  // Extract GHSA identifier from the advisory URL when present (npm audit pattern)
  if (v.url) {
    const m = GHSA_RE.exec(v.url);
    if (m) raw.push(m[0]);
  }

  if (v.advisoryId != null) {
    raw.push(String(v.advisoryId));
  }

  // Deduplicate while preserving order
  const advisoryIds = [...new Set(raw)];

  return {
    type: 'vulnerability',
    // dedupKey composed from source + package name + severity for stable dedup
    dedupKey: `pnpm-audit:${v.name}:${v.severity}`,
    sources: ['pnpm-audit'],
    title: v.title,
    detail: v.title,          // VulnerabilityInfo has no separate detail field
    package: v.name,
    version: v.currentVersion,
    path: v.path,
    severity: SEVERITY_MAP[v.severity] ?? 'info',
    advisoryIds,
    rawBySource: { 'pnpm-audit': {} }, // raw is filled in by scan() below
    fixedIn: v.fixVersion,    // VulnerabilityInfo.fixVersion maps to Finding.fixedIn
    references: v.url ? [v.url] : [],
  };
}

export const PnpmAuditSource: ScanSource = {
  id: 'pnpm-audit',
  displayName: 'pnpm/npm audit',
  findingTypes: ['vulnerability'],
  timeoutMs: 60_000,

  async isAvailable() {
    return true; // always present — uses the project's package manager
  },

  async scan(project: ProjectConfig): Promise<ScanSourceResult> {
    const pm = detectPm(project.path);
    if (!pm) return { findings: [] };

    const { vulnerabilities, raw } = await runPnpmAudit(project.path, pm);
    return {
      findings: vulnerabilities.map((v): Finding => ({
        ...vulnInfoToFinding(v),
        rawBySource: { 'pnpm-audit': raw },
      })),
    };
  },
};
