import { exec } from 'child_process';
import { promisify } from 'util';
import type { ScanSource, Finding, Severity, ScanSourceResult } from '../types';
import type { ProjectConfig } from '../../types';

const execAsync = promisify(exec);

interface GrypeArtifact { name?: string; version?: string; locations?: Array<{ path?: string }>; }
interface GrypeCvss { metrics?: { baseScore?: number } }
interface GrypeFix { state?: string; versions?: string[] }
interface GrypeVuln {
  id?: string;
  severity?: string;
  cvss?: GrypeCvss[];
  fix?: GrypeFix;
  urls?: string[];
  description?: string;
}
interface GrypeMatch {
  vulnerability?: GrypeVuln;
  relatedVulnerabilities?: Array<{ id?: string }>;
  artifact?: GrypeArtifact;
}
interface GrypeOutput { matches?: GrypeMatch[] }

const SEVERITY_MAP: Record<string, Severity> = {
  Critical: 'critical',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
  Negligible: 'info',
  Unknown: 'info',
};

export function parseGrypeJson(out: GrypeOutput): Finding[] {
  const matches = out.matches ?? [];
  return matches.map((m): Finding => {
    const v = m.vulnerability ?? {};
    const a = m.artifact ?? {};
    const advisoryIds = [
      v.id,
      ...(m.relatedVulnerabilities?.map((r) => r.id) ?? []),
    ].filter((x): x is string => Boolean(x));
    const cvss =
      (v.cvss ?? []).reduce((max, c) => Math.max(max, c.metrics?.baseScore ?? 0), 0) || undefined;
    return {
      type: 'vulnerability',
      dedupKey: '',
      sources: ['grype'],
      title: v.id ?? a.name ?? 'Unknown vulnerability',
      detail: v.description ?? '',
      package: a.name,
      version: a.version,
      path: a.locations?.[0]?.path,
      severity: SEVERITY_MAP[v.severity ?? 'Unknown'] ?? 'info',
      cvss,
      advisoryIds,
      rawBySource: { grype: m },
      fixedIn: v.fix?.state === 'fixed' ? v.fix?.versions?.[0] : undefined,
      references: v.urls ?? [],
    };
  });
}

let availableCache: boolean | null = null;

async function probe(): Promise<boolean> {
  if (availableCache !== null) return availableCache;
  try {
    await execAsync('grype --version', { timeout: 5000 });
    availableCache = true;
  } catch {
    availableCache = false;
  }
  return availableCache;
}

async function dbAgeDays(): Promise<number | null> {
  try {
    const { stdout } = await execAsync('grype db status -o json', { timeout: 5000 });
    const parsed = JSON.parse(stdout) as { built?: string };
    if (!parsed.built) return null;
    return (Date.now() - new Date(parsed.built).getTime()) / 86400000;
  } catch {
    return null;
  }
}

async function maybeUpdateDb() {
  const age = await dbAgeDays();
  if (age == null || age <= 7) return;
  await execAsync('grype db update', { timeout: 60_000 }).catch(() => {
    /* best effort */
  });
}

export const GrypeSource: ScanSource = {
  id: 'grype',
  displayName: 'Grype',
  findingTypes: ['vulnerability'],
  timeoutMs: 120_000,

  isAvailable: probe,

  async scan(project: ProjectConfig): Promise<ScanSourceResult> {
    await maybeUpdateDb();
    const { stdout } = await execAsync(
      `grype dir:${JSON.stringify(project.path)} -o json --quiet`,
      { timeout: 110_000, maxBuffer: 50 * 1024 * 1024 },
    );
    return { findings: parseGrypeJson(JSON.parse(stdout) as GrypeOutput) };
  },
};
