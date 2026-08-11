// src/lib/updaters/override.test.ts
//
// override.ts writes the overrides that hold ~35 fleet projects' transitive
// deps in place. The regression under test: applyOverrides used to write an
// EXACT pin ("postcss": "8.5.15"), which permanently blocks routine updates
// past a vulnerable version (29/32 projects were stuck this way on
// GHSA-r28c-9q8g-f849). It now writes a caret floor ("^8.5.15") instead, and
// the sibling functions (removeOverrideConflicts, cleanStaleOverrides) had to
// stop assuming exact-pin string equality so they don't immediately delete
// the floor applyOverrides just wrote.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdatePackage } from './common';

// applyOverrides shells out to the real package manager (`pnpm install`, etc.)
// after writing package.json. Actually running that in a unit test would be
// slow, flaky, and network-dependent, so execAsync is stubbed — everything
// else from './common' (NPM_INSTALL_TIMEOUT, verifyAuditClear) stays real.
// vi.mock factories are hoisted above imports, so the stub is created inline
// rather than referencing an outer const.
const { execAsyncMock } = vi.hoisted(() => ({
  execAsyncMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));
vi.mock('./common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./common')>();
  return { ...actual, execAsync: execAsyncMock };
});

// addPatchHistoryEntry/logger.* write real files under `.hexops/` in
// process.cwd(). Stub them so the test suite doesn't leave that litter in
// the repo working tree; generatePatchId and everything else in
// patch-storage stays real since patch-scanner's getUpdateType chain
// depends on other named exports from the same module existing.
vi.mock('@/lib/patch-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/patch-storage')>();
  return { ...actual, addPatchHistoryEntry: vi.fn() };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applyOverrides, removeOverrideConflicts, cleanStaleOverrides, toFloorRange } from './override';

const dirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writePkgJson(dir: string, content: unknown, indent = 2): void {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(content, null, indent)}\n`, 'utf-8');
}

function readPkgJsonRaw(dir: string): string {
  return readFileSync(join(dir, 'package.json'), 'utf-8');
}

interface PkgJsonLike {
  pnpm?: { overrides?: Record<string, string> };
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

function readPkgJson(dir: string): PkgJsonLike {
  return JSON.parse(readPkgJsonRaw(dir));
}

function writeInstalledVersion(dir: string, pkgName: string, version: string): void {
  const pkgDir = join(dir, 'node_modules', pkgName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version }), 'utf-8');
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  execAsyncMock.mockClear();
});

describe('toFloorRange', () => {
  it('turns a concrete version into a caret floor', () => {
    expect(toFloorRange('8.5.26')).toBe('^8.5.26');
  });

  it('passes dist-tags through unchanged', () => {
    expect(toFloorRange('latest')).toBe('latest');
    expect(toFloorRange('next')).toBe('next');
    expect(toFloorRange('canary')).toBe('canary');
  });

  it('carets a prerelease version rather than leaving it an exact pin', () => {
    // ^1.0.0-beta.1 only matches later prereleases within 1.0.0 plus the
    // eventual stable 1.0.0 release — narrower than a normal caret range,
    // but that's inherent to npm semver's prerelease-tuple rule, not a bug.
    expect(toFloorRange('1.0.0-beta.1')).toBe('^1.0.0-beta.1');
  });

  it('leaves an already-range value alone', () => {
    expect(toFloorRange('^8.5.23')).toBe('^8.5.23');
    expect(toFloorRange('>=0.28.1')).toBe('>=0.28.1');
  });
});

describe('applyOverrides', () => {
  const pkgManagers: Array<{ pm: string; overridesPath: (pkgJson: PkgJsonLike) => Record<string, string> | undefined }> = [
    { pm: 'pnpm', overridesPath: (p) => p.pnpm?.overrides },
    { pm: 'npm', overridesPath: (p) => p.overrides },
    { pm: 'yarn', overridesPath: (p) => p.resolutions },
  ];

  for (const { pm, overridesPath } of pkgManagers) {
    it(`writes a caret floor (^x.y.z) for a concrete target under ${pm}`, async () => {
      const dir = makeTmpDir(`hexops-apply-${pm}-`);
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });

      const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, pm, dir, 'test-project');

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);

      const pkgJson = readPkgJson(dir);
      expect(overridesPath(pkgJson)?.postcss).toBe('^8.5.26');
    });
  }

  it('writes a dist-tag target through unchanged (cannot caret a tag)', async () => {
    const dir = makeTmpDir('hexops-apply-tag-');
    writePkgJson(dir, { name: 'proj', version: '1.0.0' });

    const pkgs: UpdatePackage[] = [{ name: 'some-pkg', targetVersion: 'latest' }];
    const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

    expect(results[0].success).toBe(true);
    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!['some-pkg']).toBe('latest');
  });

  it('floors the direct-dependency specifier too, not just the override, under npm', async () => {
    const dir = makeTmpDir('hexops-apply-npm-direct-');
    writePkgJson(dir, { name: 'proj', version: '1.0.0', dependencies: { postcss: '8.4.31' } });

    const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.4.31', targetVersion: '8.5.26' }];
    await applyOverrides(pkgs, 'npm', dir, 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.dependencies!.postcss).toBe('^8.5.26');
  });

  it('does not warn when the resolved version satisfies the floor but is not an exact match', async () => {
    const dir = makeTmpDir('hexops-apply-satisfy-');
    writePkgJson(dir, { name: 'proj', version: '1.0.0' });
    // Simulate the install having resolved to a newer patch than the floor's base —
    // this is success, not a mismatch, now that the override is a floor.
    writeInstalledVersion(dir, 'postcss', '8.5.30');

    const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
    const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

    expect(results[0].output).not.toMatch(/resolved to .* may need lockfile reset/);
  });

  it('preserves the project package.json indentation style', async () => {
    const dir = makeTmpDir('hexops-apply-indent-');
    // 4-space indent, deliberately different from the writer's default.
    writePkgJson(dir, { name: 'proj', version: '1.0.0' }, 4);

    const pkgs: UpdatePackage[] = [{ name: 'postcss', targetVersion: '8.5.26' }];
    await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

    const raw = readPkgJsonRaw(dir);
    expect(raw).toMatch(/^ {4}"name"/m);
  });
});

describe('removeOverrideConflicts', () => {
  function pkgJsonPathFor(dir: string): string {
    return join(dir, 'package.json');
  }

  it('KEEPS an override whose range already satisfies the new target (the floor-deletion regression)', () => {
    const dir = makeTmpDir('hexops-conflicts-keep-');
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { postcss: '^8.5.23' } } });

    const directPkgs: UpdatePackage[] = [{ name: 'postcss', targetVersion: '8.5.26' }];
    removeOverrideConflicts(pkgJsonPathFor(dir), directPkgs, 'pnpm', 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!.postcss).toBe('^8.5.23');
  });

  it('REMOVES an override whose range does not satisfy the new target', () => {
    const dir = makeTmpDir('hexops-conflicts-remove-');
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { postcss: '^8.5.23' } } });

    // Major bump falls outside the caret range — the override would now
    // conflict with (block) the direct update, so it must go.
    const directPkgs: UpdatePackage[] = [{ name: 'postcss', targetVersion: '9.0.0' }];
    removeOverrideConflicts(pkgJsonPathFor(dir), directPkgs, 'pnpm', 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!.postcss).toBeUndefined();
  });

  it('REMOVES on a floating dist-tag target regardless of the existing range', () => {
    const dir = makeTmpDir('hexops-conflicts-floating-');
    writePkgJson(dir, { name: 'proj', overrides: { postcss: '^8.5.23' } });

    const directPkgs: UpdatePackage[] = [{ name: 'postcss', targetVersion: 'latest' }];
    removeOverrideConflicts(pkgJsonPathFor(dir), directPkgs, 'npm', 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.overrides!.postcss).toBeUndefined();
  });

  it('still removes a stale EXACT pin that differs from the new target (pre-floor behavior)', () => {
    const dir = makeTmpDir('hexops-conflicts-exact-');
    writePkgJson(dir, { name: 'proj', resolutions: { postcss: '8.5.15' } });

    const directPkgs: UpdatePackage[] = [{ name: 'postcss', targetVersion: '8.5.26' }];
    removeOverrideConflicts(pkgJsonPathFor(dir), directPkgs, 'yarn', 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.resolutions!.postcss).toBeUndefined();
  });

  it('preserves package.json indentation when it rewrites the file', () => {
    const dir = makeTmpDir('hexops-conflicts-indent-');
    writePkgJson(dir, { name: 'proj', overrides: { postcss: '8.5.15' } }, 4);

    const directPkgs: UpdatePackage[] = [{ name: 'postcss', targetVersion: '8.5.26' }];
    removeOverrideConflicts(pkgJsonPathFor(dir), directPkgs, 'npm', 'test-project');

    const raw = readPkgJsonRaw(dir);
    expect(raw).toMatch(/^ {4}"name"/m);
  });
});

describe('cleanStaleOverrides', () => {
  it('leaves a range-valued override untouched even when installed resolves higher', () => {
    const dir = makeTmpDir('hexops-stale-range-');
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { postcss: '^8.5.23' } } });
    writeInstalledVersion(dir, 'postcss', '8.5.30');

    cleanStaleOverrides(dir, 'pnpm', 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!.postcss).toBe('^8.5.23');
  });

  it('still removes a genuinely stale exact pin', () => {
    const dir = makeTmpDir('hexops-stale-exact-');
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { postcss: '8.5.15' } } });
    writeInstalledVersion(dir, 'postcss', '8.5.30');

    cleanStaleOverrides(dir, 'pnpm', 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!.postcss).toBeUndefined();
  });

  it('uses real semver comparison, not naive string/parseInt splitting (prerelease case)', () => {
    const dir = makeTmpDir('hexops-stale-prerelease-');
    // 1.0.0-beta.1 must NOT be treated as "newer" than 1.0.0 — a naive
    // parseInt split on major.minor.patch would compare 1.0.0 vs 1.0.0 as
    // equal and miss the prerelease tag entirely.
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { foo: '1.0.0' } } });
    writeInstalledVersion(dir, 'foo', '1.0.0-beta.1');

    cleanStaleOverrides(dir, 'pnpm', 'test-project');

    const pkgJson = readPkgJson(dir);
    // 1.0.0-beta.1 is NOT newer than 1.0.0, so the pin must survive.
    expect(pkgJson.pnpm!.overrides!.foo).toBe('1.0.0');
  });

  it('preserves package.json indentation when it rewrites the file', () => {
    const dir = makeTmpDir('hexops-stale-indent-');
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { postcss: '8.5.15' } } }, 4);
    writeInstalledVersion(dir, 'postcss', '8.5.30');

    cleanStaleOverrides(dir, 'pnpm', 'test-project');

    const raw = readPkgJsonRaw(dir);
    expect(raw).toMatch(/^ {4}"name"/m);
  });
});
