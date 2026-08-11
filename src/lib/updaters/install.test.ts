// src/lib/updaters/install.test.ts
//
// Covers the "version unchanged after install" guard in installPackages
// (the batch-install verification branch, ~line 139). That guard exists to
// catch a package manager reporting success while silently not actually
// updating anything. It used to fire whenever `installed.version ===
// pkg.fromVersion`, full stop — which was safe only because route.ts almost
// always passed `fromVersion: undefined` for requests that omitted it (a
// raw request field, rarely populated by callers). Once route.ts started
// passing the node_modules-read `effectiveFromVersion` instead (see
// override.ts's isolated-linker fix and the accompanying route.ts change),
// `fromVersion` can legitimately equal the pre-install installed version in
// the benign "already at the target, re-requested from a stale scan cache"
// case — and the unnarrowed guard would have reported that as a failure.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdatePackage } from './common';

const { execAsyncMock } = vi.hoisted(() => ({
  execAsyncMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));
vi.mock('./common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./common')>();
  return { ...actual, execAsync: execAsyncMock };
});
vi.mock('@/lib/patch-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/patch-storage')>();
  return { ...actual, addPatchHistoryEntry: vi.fn() };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { installPackages } from './install';

const dirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeInstalledVersion(dir: string, pkgName: string, version: string): void {
  const pkgDir = join(dir, 'node_modules', pkgName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version }), 'utf-8');
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  execAsyncMock.mockReset();
  execAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('installPackages — version-unchanged verification', () => {
  it('does NOT report failure when the package is already at the requested target (benign no-op)', async () => {
    const dir = makeTmpDir('hexops-install-alreadytarget-');
    // Simulates: route.ts read the currently-installed version (8.5.26) as
    // effectiveFromVersion because the request omitted fromVersion, and the
    // requested target also happens to be 8.5.26 — e.g. a stale scan cache
    // re-surfacing a patch that was already applied. The install command
    // "succeeds" (exit 0) and, correctly, leaves the version unchanged.
    writeInstalledVersion(dir, 'postcss', '8.5.26');

    const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.26', targetVersion: '8.5.26' }];
    const results = await installPackages(pkgs, 'npm', false, dir, 'test-project');

    expect(results[0].success).toBe(true);
    expect(results[0].error).toBeUndefined();
  });

  it('still reports failure when the version genuinely did not change (real no-op)', async () => {
    const dir = makeTmpDir('hexops-install-genuinefail-');
    // fromVersion and the installed version match, but the TARGET was
    // different — the install command exited 0 without actually doing
    // anything. This is exactly the failure mode the guard exists to catch,
    // and the narrowed guard must still catch it.
    writeInstalledVersion(dir, 'postcss', '8.5.15');

    const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
    const results = await installPackages(pkgs, 'npm', false, dir, 'test-project');

    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/version did not change/);
  });

  it('reports success for a normal update where the version actually moved', async () => {
    const dir = makeTmpDir('hexops-install-normal-');
    writeInstalledVersion(dir, 'postcss', '8.5.26');

    const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
    const results = await installPackages(pkgs, 'npm', false, dir, 'test-project');

    expect(results[0].success).toBe(true);
  });

  it('does not flag a floating-tag target (latest) as unchanged even if fromVersion happens to match', async () => {
    const dir = makeTmpDir('hexops-install-floating-');
    // A floating target is exempt from this guard entirely regardless of
    // whether the installed version happens to equal fromVersion.
    writeInstalledVersion(dir, 'postcss', '8.5.15');

    const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: 'latest' }];
    const results = await installPackages(pkgs, 'npm', false, dir, 'test-project');

    expect(results[0].success).toBe(true);
  });
});
