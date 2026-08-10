import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auto-apply-flag', () => ({ OVERRIDE_HYGIENE_FIX_ENABLED: false }));
vi.mock('@/lib/config', () => ({ getProject: vi.fn() }));
vi.mock('@/lib/security/override-audit', () => ({
  runOverrideAudit: vi.fn(),
  overrideAuditAvailable: vi.fn(() => true),
}));
vi.mock('@/lib/process-manager', () => ({ runWithDevServerGuard: vi.fn() }));
vi.mock('@/lib/security/runner', () => ({ scanProject: vi.fn() }));

import { POST } from './route';
import { getProject } from '@/lib/config';

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) =>
  new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }) as never;

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/security/overrides/[id]/fix', () => {
  it('409s when OVERRIDE_HYGIENE_FIX_ENABLED is off, before touching the project', async () => {
    const res = await POST(req({}), params('p'));
    expect(res.status).toBe(409);
    expect(vi.mocked(getProject)).not.toHaveBeenCalled();
  });
});
