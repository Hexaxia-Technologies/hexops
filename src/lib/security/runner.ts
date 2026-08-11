import { existsSync } from 'fs';
import type { ProjectConfig } from '../types';
import { ScanSkippedError, type Finding, type ScanResult, type ScanSource, type SourceResult, type SourceStatus } from './types';
import { mergeFindings } from './merger';
import { writeSecurityCache } from './persistence';
import { SOURCES } from './sources';
import { applyScan } from './finding-states';
import { logger } from '../logger';

const DEFAULT_TIMEOUT_MS = 60_000;
const inflight = new Map<string, Promise<ScanResult>>();

/**
 * Races a promise against a deadline.
 *
 * NOTE: When the timeout fires, the underlying promise `p` continues
 * executing in the background until natural completion — there is no
 * AbortSignal plumbing here. Sources that spawn child processes (e.g. Grype
 * shelling out to a binary) must give those processes their own internal
 * timeout (e.g. the `timeout` option on `execAsync`) so they don't outlive
 * the runner's deadline. The runner timeout is a safety net, not a kill
 * switch.
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  const winner = await Promise.race([p.then((value) => ({ ok: true as const, value })), timeout]);
  if (timer) clearTimeout(timer);
  return winner;
}

async function runOne(source: ScanSource, project: ProjectConfig): Promise<{ result: SourceResult; findings: Finding[] }> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let status: SourceStatus = 'ok';
  let error: string | undefined;
  let warning: string | undefined;
  let findings: Finding[] = [];

  const available = await source.isAvailable().catch(() => false);
  if (!available) {
    status = 'unavailable';
  } else {
    const timeout = source.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const outcome = await withTimeout(source.scan(project), timeout).catch((err) => {
      if (err instanceof ScanSkippedError) {
        status = 'skipped';
        error = err.message;
      } else {
        error = err instanceof Error ? err.message : String(err);
        status = 'failed';
      }
      return { ok: false } as const;
    });
    if (status === 'ok' && 'ok' in outcome && outcome.ok) {
      findings = outcome.value.findings;
      warning = outcome.value.warning;
    } else if (status === 'ok') {
      status = 'timeout';
    }
  }

  return {
    findings,
    result: {
      id: source.id,
      status,
      startedAt,
      durationMs: Date.now() - start,
      findingCount: findings.length,
      error,
      warning,
    },
  };
}

export const _runOneForTest = runOne;

/**
 * Missing-path check runs once here, before any source is invoked, rather
 * than inside each source's scan(). The path being absent affects every
 * source identically — there's nothing source-specific to say about it — so
 * a single pre-flight check keeps the "misconfigured" message consistent
 * across sources instead of each one inventing its own wording (and its own
 * way of detecting the same condition).
 */
function buildMisconfiguredResult(sourceId: string, message: string): SourceResult {
  return {
    id: sourceId,
    status: 'misconfigured',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    findingCount: 0,
    error: message,
  };
}

export async function scanProjectWithSources(project: ProjectConfig, sources: ScanSource[]): Promise<ScanResult> {
  const existing = inflight.get(project.id);
  if (existing) return existing;

  const promise = (async () => {
    const start = Date.now();
    const perSource = new Map<string, Finding[]>();
    const sourcesRecord: Record<string, SourceResult> = {};

    const pathMissing = !existsSync(project.path);
    if (pathMissing) {
      const message = `Configured project path does not exist: ${project.path}`;
      for (const s of sources) {
        sourcesRecord[s.id] = buildMisconfiguredResult(s.id, message);
        perSource.set(s.id, []);
      }
    } else {
      await Promise.all(sources.map(async (s) => {
        try {
          const { result, findings } = await runOne(s, project);
          sourcesRecord[s.id] = result;
          perSource.set(s.id, findings);
        } catch (err) {
          sourcesRecord[s.id] = {
            id: s.id,
            status: 'failed',
            startedAt: new Date().toISOString(),
            durationMs: 0,
            findingCount: 0,
            error: err instanceof Error ? err.message : String(err),
          };
          perSource.set(s.id, []);
        }
      }));
    }

    const findings = mergeFindings(perSource);
    const result: ScanResult = {
      cacheVersion: 1,
      projectId: project.id,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      sources: sourcesRecord,
      findings,
    };

    // Diff findings against stored states BEFORE writing cache so lifecycle
    // log entries appear in order with the scan completion.
    const diff = applyScan(project.id, findings);
    const findingByKey = new Map(findings.map(f => [f.dedupKey, f] as const));

    for (const key of diff.newlyDetected) {
      const f = findingByKey.get(key);
      logger.info('security', 'finding_detected', `New finding ${key} in ${project.id}`, {
        projectId: project.id,
        meta: {
          findingId: key,
          severity: f?.severity,
          package: f?.package,
          version: f?.version,
          advisoryIds: f?.advisoryIds,
          sources: f?.sources,
        },
      });
    }
    for (const key of diff.redetected) {
      const f = findingByKey.get(key);
      logger.info('security', 'finding_redetected', `Finding ${key} returned in ${project.id}`, {
        projectId: project.id,
        meta: {
          findingId: key,
          severity: f?.severity,
          package: f?.package,
          version: f?.version,
          advisoryIds: f?.advisoryIds,
          sources: f?.sources,
        },
      });
    }
    for (const key of diff.resolved) {
      logger.info('security', 'finding_resolved', `Finding ${key} resolved in ${project.id}`, {
        projectId: project.id,
        meta: { findingId: key },
      });
    }

    writeSecurityCache(project.id, result);
    return result;
  })();

  inflight.set(project.id, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(project.id);
  }
}

export async function scanProject(project: ProjectConfig): Promise<ScanResult> {
  return scanProjectWithSources(project, SOURCES);
}
