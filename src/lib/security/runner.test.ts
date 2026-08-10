import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { _setCacheDirForTest } from './persistence';
import { _setFindingStatesDirForTest } from './finding-states';
import { scanProjectWithSources, _runOneForTest } from './runner';
import type { ScanSource, Finding } from './types';
import type { ProjectConfig } from '../types';

const project: ProjectConfig = {
  id: 'p1', name: 'P1', path: '/tmp/p1', port: 3000, category: 'Internal',
  scripts: { dev: 'pnpm dev', build: 'pnpm build' },
};

function source(id: string, behavior: Partial<{
  findings: Finding[];
  available: boolean;
  throw: string;
  delayMs: number;
}>): ScanSource {
  return {
    id,
    displayName: id,
    findingTypes: ['vulnerability'],
    timeoutMs: behavior.delayMs && behavior.delayMs > 50 ? 50 : undefined,
    isAvailable: async () => behavior.available ?? true,
    scan: async () => {
      if (behavior.delayMs) await new Promise(r => setTimeout(r, behavior.delayMs));
      if (behavior.throw) throw new Error(behavior.throw);
      return { findings: behavior.findings ?? [] };
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hexops-runner-'));
  _setCacheDirForTest(dir);
  _setFindingStatesDirForTest(dir);
  return () => {
    _setFindingStatesDirForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  };
});

describe('runner.scanProjectWithSources', () => {
  it('records ok status when source returns findings', async () => {
    const finding: Finding = {
      type: 'vulnerability', dedupKey: '', sources: [], title: 't', detail: '',
      severity: 'high', advisoryIds: ['GHSA-x'], rawBySource: {}, references: [],
    };
    const result = await scanProjectWithSources(project, [source('s1', { findings: [finding] })]);
    expect(result.sources.s1.status).toBe('ok');
    expect(result.sources.s1.findingCount).toBe(1);
    expect(result.findings).toHaveLength(1);
  });

  it('records unavailable status when isAvailable returns false', async () => {
    const result = await scanProjectWithSources(project, [source('s1', { available: false })]);
    expect(result.sources.s1.status).toBe('unavailable');
    expect(result.findings).toHaveLength(0);
  });

  it('records failed status when source throws', async () => {
    const result = await scanProjectWithSources(project, [source('s1', { throw: 'kaboom' })]);
    expect(result.sources.s1.status).toBe('failed');
    expect(result.sources.s1.error).toContain('kaboom');
  });

  it('records timeout status when source exceeds its timeout', async () => {
    const result = await scanProjectWithSources(project, [source('s1', { delayMs: 200 })]);
    expect(result.sources.s1.status).toBe('timeout');
  });

  it('continues with other sources when one fails', async () => {
    const f: Finding = {
      type: 'vulnerability', dedupKey: '', sources: [], title: 't', detail: '',
      severity: 'high', advisoryIds: ['GHSA-x'], rawBySource: {}, references: [],
    };
    const result = await scanProjectWithSources(project, [
      source('s1', { throw: 'boom' }),
      source('s2', { findings: [f] }),
    ]);
    expect(result.sources.s1.status).toBe('failed');
    expect(result.sources.s2.status).toBe('ok');
    expect(result.findings).toHaveLength(1);
  });

  it('writes the result to cache', async () => {
    await scanProjectWithSources(project, [source('s1', { findings: [] })]);
    const { readSecurityCache } = await import('./persistence');
    const cached = readSecurityCache('p1');
    expect(cached).not.toBeNull();
    expect(cached?.sources.s1.status).toBe('ok');
  });

  it('coalesces concurrent calls into one scan via mutex', async () => {
    let calls = 0;
    const slow: ScanSource = {
      ...source('s1', {}),
      scan: async () => {
        calls++;
        await new Promise(r => setTimeout(r, 50));
        return { findings: [] };
      },
    };
    const [a, b] = await Promise.all([
      scanProjectWithSources(project, [slow]),
      scanProjectWithSources(project, [slow]),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it('propagates a source warning onto the SourceResult', async () => {
    const source: ScanSource = {
      id: 'warner',
      displayName: 'Warner',
      findingTypes: ['config'],
      isAvailable: async () => true,
      scan: async () => ({ findings: [], warning: 'partial scan: 2 advisories unresolved' }),
    };
    const { result } = await _runOneForTest(source, { id: 'p', name: 'p', path: '/tmp' } as ProjectConfig);
    expect(result.status).toBe('ok');
    expect(result.warning).toBe('partial scan: 2 advisories unresolved');
  });

  it('leaves warning undefined when a source reports none', async () => {
    const source: ScanSource = {
      id: 'quiet',
      displayName: 'Quiet',
      findingTypes: ['config'],
      isAvailable: async () => true,
      scan: async () => ({ findings: [] }),
    };
    const { result } = await _runOneForTest(source, { id: 'p', name: 'p', path: '/tmp' } as ProjectConfig);
    expect(result.warning).toBeUndefined();
  });
});
