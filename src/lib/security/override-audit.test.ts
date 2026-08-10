import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOverrideCommand } from './override-audit';
import type { OverrideAuditOutput } from './override-audit';

describe('buildOverrideCommand', () => {
  it('puts the path before the subcommand and quotes every part', () => {
    expect(buildOverrideCommand('/bin/cve-lite', '/p/my proj')).toBe(
      '"/bin/cve-lite" "/p/my proj" "overrides" "--json"',
    );
  });

  it('appends extra flags after --json', () => {
    expect(buildOverrideCommand('/bin/cve-lite', '/p', ['--rule', 'OA009'])).toBe(
      '"/bin/cve-lite" "/p" "overrides" "--json" "--rule" "OA009"',
    );
  });
});

describe('recorded 1.28 overrides fixture', () => {
  it('has the shape the parser depends on', () => {
    const out = JSON.parse(
      readFileSync(join(__dirname, 'sources/__fixtures__/cve-lite-1.28-overrides.json'), 'utf-8'),
    ) as OverrideAuditOutput;
    expect(out.findings?.length).toBeGreaterThan(0);
    const f = out.findings![0];
    expect(f.ruleId).toMatch(/^(OA|PD)\d{3}$/);
    expect(f.location?.file).toBe('package.json');
    expect(f.location?.jsonPath).toContain('/overrides/');
  });
});
