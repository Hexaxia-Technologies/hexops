import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOverrideCommand, classifyMissingOverrideOutput } from './override-audit';
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

describe('classifyMissingOverrideOutput', () => {
  it('classifies the CLI\'s "no package.json" error as no-package-json (hextrace case: planning-only repo)', () => {
    const outcome = classifyMissingOverrideOutput({
      execErrorMessage: 'Command failed with exit code 3',
      stdout: '',
      stderr: 'overrides: buildOverrideContext: no package.json at /home/aaron/Projects/hextrace',
    });
    expect(outcome.kind).toBe('no-package-json');
  });

  it('classifies any other failure as error, carrying the exec error message', () => {
    const outcome = classifyMissingOverrideOutput({
      execErrorMessage: 'spawn ENOENT',
      stdout: '',
      stderr: '',
    });
    expect(outcome).toEqual({
      kind: 'error',
      message: 'cve-lite overrides produced no output: spawn ENOENT',
    });
  });

  it('falls back to a generic message when there is no exec error message', () => {
    const outcome = classifyMissingOverrideOutput({ stdout: '', stderr: '' });
    expect(outcome).toEqual({ kind: 'error', message: 'cve-lite overrides produced no output' });
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
