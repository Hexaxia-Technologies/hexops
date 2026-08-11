// src/app/api/projects/[id]/update/route.guard.test.ts
// #109 — applying a patch to hexops itself, while its dev server serves the
// request, must be refused (you cannot stop->apply->restart that process).
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auto-apply-flag', () => ({ AUTO_APPLY_ENABLED: true as boolean }));

// getProject returns hexops's OWN checkout (path === cwd) -> isHexopsSelf is true
vi.mock('@/lib/config', () => ({
  getProject: vi.fn().mockReturnValue({
    id: 'hexops',
    path: process.cwd(),
    name: 'HexOps',
    port: 3000,
    category: 'app',
    scripts: { dev: 'next dev', build: 'next build' },
  }),
  getProjects: vi.fn().mockReturnValue([]),
}));
vi.mock('@/lib/patch-storage', () => ({ invalidateProjectCache: vi.fn() }));
vi.mock('@/lib/patch-scanner', () => ({ detectPackageManager: vi.fn(), scanProject: vi.fn() }));
vi.mock('@/lib/lockfile-resolver', () => ({
  // would short-circuit to 500 if the guard let us through — proving the guard ran
  resolveLockfile: vi.fn().mockResolvedValue({ success: false, packageManager: 'pnpm', mode: 'clean-slate' }),
}));
vi.mock('@/lib/settings', () => ({
  getGlobalSettings: vi.fn().mockReturnValue({}),
  getProjectSettings: vi.fn().mockReturnValue({}),
}));
vi.mock('@/lib/extended-status', () => ({ invalidatePackageStatusCache: vi.fn() }));
vi.mock('@/app/api/projects/[id]/package-health/route', () => ({ clearInMemoryCache: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/updaters/common', () => ({ verifyAuditClear: vi.fn(), execAsync: vi.fn() }));
vi.mock('@/lib/updaters/npm', () => ({
  checkNodeModulesHealth: vi.fn(),
  cleanNodeModules: vi.fn(),
  buildNpmUpdateCmd: vi.fn(),
}));
vi.mock('@/lib/updaters/pnpm', () => ({
  checkPnpmLockfileHealth: vi.fn(),
  repairPnpmLockfile: vi.fn(),
  buildPnpmUpdateCmd: vi.fn(),
}));
vi.mock('@/lib/updaters/yarn', () => ({ buildYarnUpdateCmd: vi.fn() }));
vi.mock('@/lib/updaters/override', () => ({
  applyOverrides: vi.fn(),
  removeOverrideConflicts: vi.fn(),
  cleanStaleOverrides: vi.fn(),
  findAllInstalledVersions: vi.fn().mockReturnValue({ root: undefined, all: [] }),
  pickLowestVersion: vi.fn().mockReturnValue(undefined),
}));
vi.mock('@/lib/updaters/install', () => ({ installPackages: vi.fn() }));

import { POST } from './route';

describe('POST /update — #109 self-patch guard', () => {
  it('refuses with 409 when the target project is hexops itself', async () => {
    const req = new NextRequest('http://localhost/api/projects/hexops/update', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ id: 'hexops' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.devServerGuard?.action).toBe('block-self');
  });
});
