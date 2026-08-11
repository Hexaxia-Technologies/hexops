import type { ProjectConfig } from '../types';

export type FindingType =
  | 'vulnerability'
  | 'integrity'
  | 'secret'
  | 'license'
  | 'config';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface Remediation {
  source: string;                 // e.g. 'cve-lite'
  validatedFixVersion?: string;   // verified-non-vulnerable target
  runnableFixCommand?: string;    // e.g. "npm install axios@0.31.1"
  recommendedAction?: string;     // human-readable sentence
  parentUpgrade?: string;         // display summary for transitive parent-upgrade path
  relationship?: 'direct' | 'transitive';
}

export interface Finding {
  type: FindingType;
  dedupKey: string;
  sources: string[];
  title: string;
  detail: string;
  package?: string;
  version?: string;
  path?: string;
  severity: Severity;
  cvss?: number;
  divergent?: boolean;
  advisoryIds: string[];
  rawBySource: Record<string, unknown>;
  fixedIn?: string;
  references: string[];
  remediation?: Remediation;      // populated only by cve-lite
  reachable?: boolean | null;     // from --usage; null = not analyzed / unknown
}

/**
 * - 'skipped': the source ran (or would have run) but there was nothing to
 *   scan — e.g. cve-lite found no supported lockfile and no exact-pinned
 *   deps in package.json. Informational, NOT a failure.
 * - 'misconfigured': the project's configured path doesn't exist/isn't
 *   readable, so no source could run at all. A config error — loud and
 *   unambiguous, but distinct from a genuine scan failure.
 */
export type SourceStatus = 'ok' | 'failed' | 'unavailable' | 'timeout' | 'skipped' | 'misconfigured';

/**
 * Thrown by a ScanSource's scan() to signal "nothing to scan" rather than a
 * failure — e.g. cve-lite exits 0 with no output file because it found zero
 * scannable packages. The runner catches this and records status 'skipped'
 * instead of 'failed'.
 */
export class ScanSkippedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanSkippedError';
  }
}

export interface SourceResult {
  id: string;
  status: SourceStatus;
  startedAt: string;
  durationMs: number;
  findingCount: number;
  error?: string;
  warning?: string;
}

export interface ScanResult {
  cacheVersion: 1;
  projectId: string;
  timestamp: string;
  durationMs: number;
  sources: Record<string, SourceResult>;
  findings: Finding[];
}

export interface ScanSourceResult {
  findings: Finding[];
  /** Set when the source succeeded but could not cover everything. Surfaces as SourceResult.warning. */
  warning?: string;
}

export interface ScanSource {
  id: string;
  displayName: string;
  findingTypes: FindingType[];
  timeoutMs?: number;
  isAvailable(): Promise<boolean>;
  scan(project: ProjectConfig): Promise<ScanSourceResult>;
}
