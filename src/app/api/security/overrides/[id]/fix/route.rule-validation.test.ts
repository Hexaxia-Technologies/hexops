import { describe, it, expect, vi, beforeEach } from 'vitest';

// This file exists to exercise the rule-validation branch, which the flag=false
// test in route.test.ts can never reach (it 409s before validation runs). The
// flag must be mocked true here — via a separate test file rather than
// vi.resetModules()/vi.doMock() in the same file — to get an isolated module
// registry with OVERRIDE_HYGIENE_FIX_ENABLED=true without touching the shipped
// default in src/lib/auto-apply-flag.ts, which must stay false (F4).
vi.mock('@/lib/auto-apply-flag', () => ({ OVERRIDE_HYGIENE_FIX_ENABLED: true }));
vi.mock('@/lib/config', () => ({
  getProject: vi.fn(() => ({ id: 'p', name: 'p', path: '/tmp/p' })),
}));
vi.mock('@/lib/security/override-audit', () => ({
  runOverrideAudit: vi.fn(),
  overrideAuditAvailable: vi.fn(() => true),
}));
vi.mock('@/lib/process-manager', () => ({ runWithDevServerGuard: vi.fn() }));
vi.mock('@/lib/security/runner', () => ({ scanProject: vi.fn().mockResolvedValue(undefined) }));

import { POST } from './route';
import { runWithDevServerGuard } from '@/lib/process-manager';
import { runOverrideAudit } from '@/lib/security/override-audit';
import { scanProject } from '@/lib/security/runner';

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) =>
  new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }) as never;

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/security/overrides/[id]/fix — rule validation (flag enabled)', () => {
  it('400s when rule is an array (would otherwise coerce to a matching string via toString())', async () => {
    const res = await POST(req({ rule: ['OA009'] }), params('p'));
    expect(res.status).toBe(400);
    expect(vi.mocked(runWithDevServerGuard)).not.toHaveBeenCalled();
  });

  it('400s when rule is a number', async () => {
    const res = await POST(req({ rule: 123 }), params('p'));
    expect(res.status).toBe(400);
    expect(vi.mocked(runWithDevServerGuard)).not.toHaveBeenCalled();
  });

  it('still accepts a valid string rule and proceeds past validation', async () => {
    vi.mocked(runWithDevServerGuard).mockResolvedValue({
      decision: 'passthrough',
      reason: 'no managed dev server',
      blocked: false,
      result: { ok: true, summary: 'done' },
      stopped: false,
      restarted: false,
    } as never);
    vi.mocked(runOverrideAudit).mockResolvedValue({ findings: [] });
    const res = await POST(req({ rule: 'OA009' }), params('p'));
    expect(res.status).toBe(200);
    expect(vi.mocked(runWithDevServerGuard)).toHaveBeenCalled();
    const body = await res.json();
    expect(body.devServerGuard).toEqual({ action: 'passthrough', stopped: false, restarted: false });
  });
});
