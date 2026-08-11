// src/app/api/projects/[id]/update/route.enabled.test.ts
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Flag mocked TRUE — guard should not block
vi.mock('@/lib/auto-apply-flag', () => ({ AUTO_APPLY_ENABLED: true as boolean }));

// Minimal mocks — we only need to get past the guard; lockfile failure short-circuits
vi.mock('@/lib/config', () => ({
  getProject: vi.fn().mockReturnValue({ id: 'test', path: '/tmp/test', name: 'Test' }),
}));
vi.mock('@/lib/patch-storage', () => ({ invalidateProjectCache: vi.fn() }));
vi.mock('@/lib/patch-scanner', () => ({ detectPackageManager: vi.fn(), scanProject: vi.fn() }));
vi.mock('@/lib/lockfile-resolver', () => ({
  resolveLockfile: vi.fn().mockResolvedValue({ success: false, packageManager: 'npm', mode: 'clean-slate' }),
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
  pickPrimaryVersion: vi.fn().mockReturnValue(undefined),
}));
vi.mock('@/lib/updaters/install', () => ({ installPackages: vi.fn() }));

import { POST } from './route';

describe('POST /update — AUTO_APPLY_ENABLED gate (enabled)', () => {
  it('proceeds past the gate when AUTO_APPLY_ENABLED is true', async () => {
    const req = new NextRequest('http://localhost/api/projects/test/update', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ id: 'test' }) });
    // Guard passed — lockfile failure returns 500, not 409
    expect(res.status).not.toBe(409);
  });
});
