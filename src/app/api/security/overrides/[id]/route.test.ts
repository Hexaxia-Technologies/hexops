import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config', () => ({ getProject: vi.fn() }));
vi.mock('@/lib/security/override-audit', () => ({
  runOverrideAudit: vi.fn(),
  overrideAuditAvailable: vi.fn(() => true),
}));

import { GET } from './route';
import { getProject } from '@/lib/config';
import { runOverrideAudit, overrideAuditAvailable } from '@/lib/security/override-audit';

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/security/overrides/[id]', () => {
  it('404s for an unknown project', async () => {
    vi.mocked(getProject).mockReturnValue(undefined as never);
    const res = await GET(new Request('http://x/') as never, params('nope'));
    expect(res.status).toBe(404);
  });

  it('503s when cve-lite is not installed', async () => {
    vi.mocked(getProject).mockReturnValue({ id: 'p', name: 'p', path: '/tmp' } as never);
    vi.mocked(overrideAuditAvailable).mockReturnValue(false);
    const res = await GET(new Request('http://x/') as never, params('p'));
    expect(res.status).toBe(503);
  });

  it('returns findings and mapped rows', async () => {
    vi.mocked(getProject).mockReturnValue({ id: 'p', name: 'p', path: '/tmp' } as never);
    vi.mocked(overrideAuditAvailable).mockReturnValue(true);
    vi.mocked(runOverrideAudit).mockResolvedValue({
      findings: [{ ruleId: 'OA009', severity: 'low', package: { name: 'ws' }, message: 'stale floor' }],
    });
    const res = await GET(new Request('http://x/') as never, params('p'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.findings).toHaveLength(1);
    expect(body.rows[0].title).toContain('OA009');
  });

  it('excludes PD001/PD002 from the raw findings array, not just rows (F2)', async () => {
    vi.mocked(getProject).mockReturnValue({ id: 'p', name: 'p', path: '/tmp' } as never);
    vi.mocked(overrideAuditAvailable).mockReturnValue(true);
    vi.mocked(runOverrideAudit).mockResolvedValue({
      findings: [
        { ruleId: 'PD001', severity: 'high', package: { name: 'js-yaml' }, message: 'phantom' },
        { ruleId: 'OA009', severity: 'low', package: { name: 'ws' }, message: 'stale floor' },
      ],
    });
    const res = await GET(new Request('http://x/') as never, params('p'));
    const body = await res.json();
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].ruleId).toBe('OA009');
  });

  it('passes force through when ?force is present', async () => {
    vi.mocked(getProject).mockReturnValue({ id: 'p', name: 'p', path: '/tmp' } as never);
    vi.mocked(overrideAuditAvailable).mockReturnValue(true);
    vi.mocked(runOverrideAudit).mockResolvedValue({ findings: [] });
    await GET(new Request('http://x/?force=1') as never, params('p'));
    expect(vi.mocked(runOverrideAudit).mock.calls[0][1]).toEqual({ force: true });
  });
});
