import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOverrideAuditJson } from './override-hygiene';
import { computeDedupKey } from '../merger';
import type { OverrideAuditOutput } from '../override-audit';

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__/cve-lite-1.28-overrides.json'), 'utf-8'),
) as OverrideAuditOutput;

describe('parseOverrideAuditJson', () => {
  it('maps the recorded fixture to config findings', () => {
    const findings = parseOverrideAuditJson(FIXTURE);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.type === 'config')).toBe(true);
    expect(findings.every((f) => f.sources[0] === 'override-hygiene')).toBe(true);
    expect(findings[0].severity).toBe('low');
    expect(findings[0].title).toContain('OA009');
  });

  it('gives same-rule findings on different packages distinct dedup keys', () => {
    const findings = parseOverrideAuditJson(FIXTURE);
    const keys = findings.map((f) => computeDedupKey(f));
    expect(new Set(keys).size).toBe(findings.length);
  });

  it('filters out PD001 and PD002 so DependencyHealthSource stays authoritative', () => {
    const findings = parseOverrideAuditJson({
      findings: [
        { ruleId: 'PD001', severity: 'high', package: { name: 'js-yaml' }, message: 'phantom' },
        { ruleId: 'PD002', severity: 'medium', package: { name: 'pg' }, message: 'phantom' },
        { ruleId: 'OA001', severity: 'high', package: { name: 'x' }, message: 'orphaned' },
      ],
    });
    expect(findings.map((f) => f.package)).toEqual(['x']);
  });

  it('carries the runnable fix command into remediation', () => {
    const findings = parseOverrideAuditJson(FIXTURE);
    expect(findings[0].remediation?.runnableFixCommand).toContain('overrides --fix');
    expect(findings[0].remediation?.source).toBe('override-hygiene');
  });

  it('falls back to info severity for an unrecognised value', () => {
    const findings = parseOverrideAuditJson({
      findings: [{ ruleId: 'OA003', severity: 'weird', package: { name: 'z' }, message: 'm' }],
    });
    expect(findings[0].severity).toBe('info');
  });

  it('returns an empty array for an empty report', () => {
    expect(parseOverrideAuditJson({})).toEqual([]);
  });
});
