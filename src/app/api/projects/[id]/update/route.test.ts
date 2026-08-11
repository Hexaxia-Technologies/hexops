// src/app/api/projects/[id]/update/route.test.ts
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Flag mocked false — tests the 409 gate
vi.mock('@/lib/auto-apply-flag', () => ({ AUTO_APPLY_ENABLED: false as boolean }));

// Mock all filesystem/exec dependencies so the route can be imported in tests
vi.mock('@/lib/config', () => ({
  getProject: vi.fn().mockReturnValue({ id: 'test', path: '/tmp/test', name: 'Test' }),
}));
vi.mock('@/lib/patch-storage', () => ({ invalidateProjectCache: vi.fn() }));
vi.mock('@/lib/patch-scanner', () => ({ detectPackageManager: vi.fn(), scanProject: vi.fn() }));
vi.mock('@/lib/lockfile-resolver', () => ({ resolveLockfile: vi.fn() }));
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

describe('POST /update — AUTO_APPLY_ENABLED gate', () => {
  it('returns 409 with disabled message when AUTO_APPLY_ENABLED is false', async () => {
    const req = new NextRequest('http://localhost/api/projects/test/update', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ id: 'test' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/disabled/i);
  });
});
