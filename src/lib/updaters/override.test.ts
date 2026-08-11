// src/lib/updaters/override.test.ts
//
// override.ts writes the overrides that hold ~35 fleet projects' transitive
// deps in place. The regression under test: applyOverrides used to write an
// EXACT pin ("postcss": "8.5.15"), which permanently blocks routine updates
// past a vulnerable version (29/32 projects were stuck this way on
// GHSA-r28c-9q8g-f849). It now writes a `>=` floor ("postcss": ">=8.5.15")
// instead — not a caret, because caret is inert below 1.0.0 and caps at the
// next major even above 1.0.0 (see toFloorRange's JSDoc for the full
// rationale) — and the sibling functions (removeOverrideConflicts,
// cleanStaleOverrides) had to stop assuming exact-pin string equality so
// they don't immediately delete the floor applyOverrides just wrote.

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
import { logger } from '@/lib/logger';

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

// Simulates pnpm's default `node-linker=isolated` virtual store layout:
// node_modules/.pnpm/<name>@<version>[_peerSuffix]/node_modules/<name>/package.json,
// with scoped names' "/" replaced by "+" in the store directory name — the
// exact convention confirmed against this repo's own `pnpm list --json`
// output (e.g. `@vitest/ui` stores as `.pnpm/@vitest+ui@4.1.9_.../...`).
// `peerSuffix` lets a test create two distinct store directories for the
// same package+version-prefix (i.e. two different peer-dep resolutions),
// or more commonly here, two different versions entirely.
function writePnpmStoreVersion(dir: string, pkgName: string, version: string, peerSuffix = ''): void {
  const storeDirName = `${pkgName.replace('/', '+')}@${version}${peerSuffix}`;
  const pkgDir = join(dir, 'node_modules', '.pnpm', storeDirName, 'node_modules', pkgName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version }), 'utf-8');
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  execAsyncMock.mockReset();
  execAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.info).mockClear();
});

describe('toFloorRange', () => {
  it('turns a concrete version into a >= floor', () => {
    expect(toFloorRange('8.5.26')).toBe('>=8.5.26');
  });

  it('passes dist-tags through unchanged', () => {
    expect(toFloorRange('latest')).toBe('latest');
    expect(toFloorRange('next')).toBe('next');
    expect(toFloorRange('canary')).toBe('canary');
  });

  it('floors a 0.x version with >=, not caret (caret is inert/too-tight below 1.0.0)', () => {
    // ^0.0.3 expands to ">=0.0.3 <0.0.4-0" — exactly one version, i.e. an
    // exact pin wearing a caret costume. >=0.0.3 has no such ceiling.
    expect(toFloorRange('0.0.3')).toBe('>=0.0.3');
    // ^0.5.1 caps at <0.6.0-0, but 0.x treats the minor as the breaking
    // axis, so that cap is still too tight for a security floor.
    expect(toFloorRange('0.5.1')).toBe('>=0.5.1');
  });

  it('floors a normal >=1.0.0 version with >=, matching the repo convention', () => {
    // Consistent with this repo's own hand-written overrides
    // (esbuild: ">=0.28.1", qs, hono, ws).
    expect(toFloorRange('8.5.26')).toBe('>=8.5.26');
  });

  it('floors a prerelease version rather than leaving it an exact pin', () => {
    expect(toFloorRange('1.0.0-beta.1')).toBe('>=1.0.0-beta.1');
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
    it(`writes a >= floor for a concrete target under ${pm}`, async () => {
      const dir = makeTmpDir(`hexops-apply-${pm}-`);
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });

      const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, pm, dir, 'test-project');

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);

      const pkgJson = readPkgJson(dir);
      expect(overridesPath(pkgJson)?.postcss).toBe('>=8.5.26');
    });
  }

  it('writes a dist-tag target through unchanged (cannot floor a tag)', async () => {
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
    expect(pkgJson.dependencies!.postcss).toBe('>=8.5.26');
  });

  it('does not warn when the resolved version satisfies the floor but is not an exact match, and reports the resolved version', async () => {
    const dir = makeTmpDir('hexops-apply-satisfy-');
    writePkgJson(dir, { name: 'proj', version: '1.0.0' });
    // Simulate the install having resolved to a newer patch than the floor's base —
    // this is success, not a mismatch, now that the override is a floor.
    writeInstalledVersion(dir, 'postcss', '8.5.30');

    const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
    const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

    expect(results[0].output).not.toMatch(/may need lockfile reset/);
    // The written floor stays visible (">=8.5.26") alongside what actually
    // resolved (8.5.30) — the point is "requested X, resolved Y", not one
    // or the other.
    expect(results[0].output).toMatch(/postcss@>=8\.5\.26, resolved 8\.5\.30/);
    expect(results[0].resolvedVersion).toBe('8.5.30');
  });

  it('WARNS when the installed version does not satisfy the written floor (resolved lower than target)', async () => {
    const dir = makeTmpDir('hexops-apply-mismatch-low-');
    writePkgJson(dir, { name: 'proj', version: '1.0.0' });
    // The resolver picked something below the floor — a genuine mismatch
    // that must still be caught (project issue #126: a bare >= previously
    // failed to move the resolved version under pnpm's node-linker=hoisted,
    // and this warning is the only thing that surfaces that).
    writeInstalledVersion(dir, 'postcss', '8.5.20');

    const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
    const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

    expect(results[0].output).toMatch(/resolved to 8\.5\.20 \(does not satisfy >=8\.5\.26\) — may need lockfile reset/);
  });

  it('WARNS on a mismatch a bare "installed >= target" scalar check would have missed', async () => {
    const dir = makeTmpDir('hexops-apply-mismatch-tuple-');
    writePkgJson(dir, { name: 'proj', version: '1.0.0' });
    // 2.0.0-alpha.1 is numerically greater than 1.0.0-beta.1 under a plain
    // semver.gte scalar comparison, so a check of that shape would have
    // reported success. It does NOT satisfy the >=1.0.0-beta.1 range that
    // was actually written (npm semver's prerelease-tuple rule excludes a
    // prerelease of a different [major,minor,patch] from an unbounded >=
    // range whose only prerelease comparator is 1.0.0-beta.1) — and that's
    // the real question: did the override we wrote take effect, not
    // whether the installed version happens to look "bigger".
    writeInstalledVersion(dir, 'weird-pkg', '2.0.0-alpha.1');

    const pkgs: UpdatePackage[] = [{ name: 'weird-pkg', targetVersion: '1.0.0-beta.1' }];
    const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

    expect(results[0].output).toMatch(/resolved to 2\.0\.0-alpha\.1 \(does not satisfy >=1\.0\.0-beta\.1\) — may need lockfile reset/);
  });

  it('logs a distinct warning — not a failure — when the resolved version is a newer major than targeted', async () => {
    const dir = makeTmpDir('hexops-apply-majorjump-');
    writePkgJson(dir, { name: 'proj', version: '1.0.0' });
    // Satisfies the >=8.5.26 floor (no ceiling, by owner decision), but
    // lands in a major well beyond the one that was targeted.
    writeInstalledVersion(dir, 'postcss', '10.1.0');

    const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
    const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

    expect(results[0].success).toBe(true);
    expect(results[0].resolvedVersion).toBe('10.1.0');
    expect(results[0].output).not.toMatch(/may need lockfile reset/); // satisfies the floor — not a mismatch
    expect(logger.warn).toHaveBeenCalledWith(
      'patches',
      'override_major_jump',
      expect.any(String),
      expect.objectContaining({
        meta: expect.objectContaining({ package: 'postcss', resolvedVersion: '10.1.0', targetMajor: 8, resolvedMajor: 10 }),
      }),
    );
  });

  describe('resolved-version lookup (isolated pnpm node-linker)', () => {
    it('finds the resolved version via the .pnpm store when there is no root node_modules entry', async () => {
      const dir = makeTmpDir('hexops-apply-pnpmstore-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      // No root node_modules/postcss at all — simulates pnpm's default
      // isolated linker, where a purely-transitive package lives only in
      // the .pnpm store. This is the concretely-identified blind spot: a
      // root-only existsSync check silently no-ops on this layout.
      writePnpmStoreVersion(dir, 'postcss', '8.5.30');

      const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(true);
      expect(results[0].resolvedVersion).toBe('8.5.30');
      expect(results[0].output).not.toMatch(/may need lockfile reset/);
    });

    it('resolves a scoped package from the .pnpm store using the "/" -> "+" name encoding', async () => {
      const dir = makeTmpDir('hexops-apply-pnpmstore-scoped-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      writePnpmStoreVersion(dir, '@scope/pkg', '2.1.0');

      const pkgs: UpdatePackage[] = [{ name: '@scope/pkg', targetVersion: '2.0.0' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].resolvedVersion).toBe('2.1.0');
    });

    it('flags a mismatch when ANY copy in the .pnpm store falls below the floor, even if others satisfy it', async () => {
      const dir = makeTmpDir('hexops-apply-pnpmstore-multi-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      // Two distinct copies coexist in the store — one satisfying, one
      // still vulnerable. A check that stopped at the first hit (or only
      // ever looked at root) would miss this — exactly the "top-level fix,
      // vulnerable nested copy survives" false-clear class this project
      // already tracks as issue #80.
      writePnpmStoreVersion(dir, 'postcss', '8.5.30');
      writePnpmStoreVersion(dir, 'postcss', '8.4.31', '_react@19.2.7');

      const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(true); // a floor violation still isn't "success: false" territory
      expect(results[0].output).toMatch(/resolved to 8\.4\.31 \(does not satisfy >=8\.5\.26\) — may need lockfile reset/);
      // The structured field must not read as clean when a violating copy
      // exists — it reports the worst (most vulnerable) offender, not
      // whichever copy happens to be "root" or highest.
      expect(results[0].resolvedVersion).toBe('8.4.31');
    });

    it('does not silently discard violations when one of the copies has an unparseable version field', async () => {
      const dir = makeTmpDir('hexops-apply-pnpmstore-garbage-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      // A non-semver `version` field (malformed package.json, a vendor
      // fork, etc.) used to make `probe.versions.sort(semver.rcompare)`
      // THROW once a second, differently-shaped copy existed — and that
      // throw was swallowed by this function's outer catch-all, discarding
      // the fact that NEITHER copy satisfies the floor along with it:
      // silent `success: true`, no warning, nothing. That's strictly worse
      // than the pre-fix existsSync no-op, because the violating versions
      // were in hand and got thrown away instead of reported.
      writePnpmStoreVersion(dir, 'weird', '1.0');
      writePnpmStoreVersion(dir, 'weird', '1.5.0', '_extra');

      const pkgs: UpdatePackage[] = [{ name: 'weird', targetVersion: '2.0.0' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(true); // still not a hard failure — see other tests for that distinction
      expect(results[0].output).toMatch(/may need lockfile reset/);
      expect(logger.warn).toHaveBeenCalledWith(
        'patches',
        'override_version_mismatch',
        expect.any(String),
        expect.objectContaining({ meta: expect.objectContaining({ package: 'weird' }) }),
      );
    });

    it('does not throw when a lone unparseable version field is the ONLY copy found', async () => {
      // Array.prototype.sort never invokes its comparator for a
      // single-element array, so a lone garbage version was already safe
      // before this fix — this test pins that it stays safe after the
      // rewrite too (parseable-filtering must not turn "one weird copy"
      // into "inconclusive" or throw).
      const dir = makeTmpDir('hexops-apply-pnpmstore-garbage-single-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      writePnpmStoreVersion(dir, 'weird', 'not-a-version');

      const pkgs: UpdatePackage[] = [{ name: 'weird', targetVersion: '2.0.0' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(true);
      expect(results[0].output).toMatch(/may need lockfile reset/);
    });

    it('does not match a package name that is merely a prefix of another (postcss vs postcss-import)', async () => {
      const dir = makeTmpDir('hexops-apply-prefix-collision-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      // Only prefix-colliding packages exist in the store — `postcss` itself
      // was never installed. The trailing "@" in the match prefix must
      // prevent "postcss-import@1.0.0" / "postcss-js@2.0.0" from being
      // mistaken for a copy of "postcss".
      writePnpmStoreVersion(dir, 'postcss-import', '1.0.0');
      writePnpmStoreVersion(dir, 'postcss-js', '2.0.0');
      // No CLI fallback data either — filesystem probe genuinely has nothing
      // for "postcss".
      execAsyncMock.mockResolvedValue({ stdout: '[]', stderr: '' });

      const pkgs: UpdatePackage[] = [{ name: 'postcss', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(true); // inconclusive is not a hard failure
      expect(results[0].resolvedVersion).toBeUndefined();
      expect(results[0].output).toMatch(/could not verify postcss's resolved version/);
    });

    it('falls back to `pnpm list --json` when the filesystem probe (root + .pnpm store) finds nothing', async () => {
      const dir = makeTmpDir('hexops-apply-clifallback-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      // No root copy, no .pnpm store directory at all — filesystem probe is
      // fully empty. This simulates a store location or workspace layout
      // the filesystem probe doesn't recognize.
      execAsyncMock.mockImplementation(async (cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('pnpm list')) {
          return {
            stdout: JSON.stringify([{
              name: 'proj',
              dependencies: { next: { version: '16.3.0', dependencies: { postcss: { version: '8.5.30' } } } },
            }]),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' }; // the install command itself
      });

      const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(true);
      expect(results[0].resolvedVersion).toBe('8.5.30');
    });

    it('reports "could not verify" — not silent success — when no method can find the package at all', async () => {
      const dir = makeTmpDir('hexops-apply-inconclusive-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      // Filesystem probe empty AND the pnpm list fallback comes back empty
      // too (e.g. `pnpm list <pkg>` finds no matching dependency path).
      execAsyncMock.mockResolvedValue({ stdout: '[]', stderr: '' });

      const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(true); // inconclusive is not treated as a hard failure
      expect(results[0].resolvedVersion).toBeUndefined();
      expect(results[0].output).toMatch(/could not verify postcss's resolved version/);
      expect(logger.warn).toHaveBeenCalledWith(
        'patches',
        'override_verify_inconclusive',
        expect.any(String),
        expect.objectContaining({ meta: expect.objectContaining({ package: 'postcss' }) }),
      );
    });

    it('the anyResolved install-failure fallback also finds a .pnpm-store-only copy (not just root)', async () => {
      const dir = makeTmpDir('hexops-apply-failrecover-pnpmstore-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      // No root copy — only the isolated-linker .pnpm store has it.
      writePnpmStoreVersion(dir, 'postcss', '8.5.30');
      execAsyncMock.mockRejectedValueOnce({ stdout: '', stderr: 'postinstall script warning', message: 'Command failed' });

      const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(true);
    });
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

  describe('install failure handling (the anyResolved fallback)', () => {
    it('reports failure — does not swallow it — when install fails and nothing on disk satisfies the target', async () => {
      const dir = makeTmpDir('hexops-apply-failhard-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      execAsyncMock.mockRejectedValueOnce({ stdout: '', stderr: 'network error', message: 'Command failed' });

      const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(false);
      expect(results[0].error).toMatch(/Failed to apply override/);
    });

    it('does not let a pre-existing copy that already satisfies the target mask a failed install', async () => {
      const dir = makeTmpDir('hexops-apply-failswallow-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      // The tree already had a version that would satisfy the NEW target's
      // written range before this call ever ran — installed === fromVersion,
      // so this is stale, not evidence the failed install actually applied
      // the override. Without the fromVersion guard, "installed >= target"
      // would have been true here and silently reported success.
      writeInstalledVersion(dir, 'postcss', '9.0.0');
      execAsyncMock.mockRejectedValueOnce({ stdout: '', stderr: 'registry 503', message: 'Command failed' });

      const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '9.0.0', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(false);
    });

    it('still recovers when install errors but the target package genuinely resolved to something new', async () => {
      const dir = makeTmpDir('hexops-apply-failrecover-');
      writePkgJson(dir, { name: 'proj', version: '1.0.0' });
      // Differs from fromVersion, so this is real evidence of a completed
      // resolution (e.g. a post-install script warning failed the overall
      // command even though the dependency graph itself resolved fine).
      writeInstalledVersion(dir, 'postcss', '8.5.30');
      execAsyncMock.mockRejectedValueOnce({ stdout: '', stderr: 'postinstall script warning', message: 'Command failed' });

      const pkgs: UpdatePackage[] = [{ name: 'postcss', fromVersion: '8.5.15', targetVersion: '8.5.26' }];
      const results = await applyOverrides(pkgs, 'pnpm', dir, 'test-project');

      expect(results[0].success).toBe(true);
    });
  });
});

describe('removeOverrideConflicts', () => {
  function pkgJsonPathFor(dir: string): string {
    return join(dir, 'package.json');
  }

  it('KEEPS an override whose range already satisfies the new target (the floor-deletion regression)', () => {
    const dir = makeTmpDir('hexops-conflicts-keep-');
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { postcss: '>=8.5.23' } } });

    const directPkgs: UpdatePackage[] = [{ name: 'postcss', targetVersion: '8.5.26' }];
    removeOverrideConflicts(pkgJsonPathFor(dir), directPkgs, 'pnpm', 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!.postcss).toBe('>=8.5.23');
  });

  it('KEEPS a >= floor even for a target in a later major (no caret ceiling to trip over)', () => {
    const dir = makeTmpDir('hexops-conflicts-keep-major-');
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { postcss: '>=8.5.23' } } });

    // This is exactly the case a caret floor could NOT have kept: a fix
    // landing in a later major. >= has no ceiling, so it still satisfies.
    const directPkgs: UpdatePackage[] = [{ name: 'postcss', targetVersion: '9.1.0' }];
    removeOverrideConflicts(pkgJsonPathFor(dir), directPkgs, 'pnpm', 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!.postcss).toBe('>=8.5.23');
  });

  it('REMOVES an override whose range does not satisfy the new target', () => {
    const dir = makeTmpDir('hexops-conflicts-remove-');
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { postcss: '>=8.5.23' } } });

    // A lower target than the floor's base falls outside the range — the
    // override would now conflict with (block) the direct update.
    const directPkgs: UpdatePackage[] = [{ name: 'postcss', targetVersion: '8.5.0' }];
    removeOverrideConflicts(pkgJsonPathFor(dir), directPkgs, 'pnpm', 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!.postcss).toBeUndefined();
  });

  it('REMOVES on a floating dist-tag target regardless of the existing range', () => {
    const dir = makeTmpDir('hexops-conflicts-floating-');
    writePkgJson(dir, { name: 'proj', overrides: { postcss: '>=8.5.23' } });

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

  it('does not throw on non-semver pinned values (workspace protocol, git URL, npm alias)', () => {
    const dir = makeTmpDir('hexops-conflicts-nonsemver-');
    writePkgJson(dir, {
      name: 'proj',
      pnpm: { overrides: { a: 'workspace:*' } },
      overrides: { b: 'git+https://github.com/x/y.git' },
      resolutions: { c: 'npm:alias@1.0.0' },
    });

    const pnpmPkgs: UpdatePackage[] = [{ name: 'a', targetVersion: '1.2.3' }];
    const npmPkgs: UpdatePackage[] = [{ name: 'b', targetVersion: '1.2.3' }];
    const yarnPkgs: UpdatePackage[] = [{ name: 'c', targetVersion: '1.2.3' }];

    expect(() => removeOverrideConflicts(pkgJsonPathFor(dir), pnpmPkgs, 'pnpm', 'test-project')).not.toThrow();
    expect(() => removeOverrideConflicts(pkgJsonPathFor(dir), npmPkgs, 'npm', 'test-project')).not.toThrow();
    expect(() => removeOverrideConflicts(pkgJsonPathFor(dir), yarnPkgs, 'yarn', 'test-project')).not.toThrow();

    // Neither side parses as semver, so it falls back to strict string
    // comparison — all three differ from the new target, so all three are
    // removed (the pre-floor behavior, preserved as the safe fallback).
    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!.a).toBeUndefined();
    expect(pkgJson.overrides!.b).toBeUndefined();
    expect(pkgJson.resolutions!.c).toBeUndefined();
  });

  it('always keeps a wildcard ("*") or empty-string override (harmless but previously untested)', () => {
    const dir = makeTmpDir('hexops-conflicts-wildcard-');
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { a: '*', b: '' } } });

    const directPkgs: UpdatePackage[] = [
      { name: 'a', targetVersion: '8.5.26' },
      { name: 'b', targetVersion: '9.0.0' },
    ];
    removeOverrideConflicts(pkgJsonPathFor(dir), directPkgs, 'pnpm', 'test-project');

    // semver parses both "*" and "" as an "any version" range, so any
    // concrete target always satisfies them — never a conflict, never
    // removed. Behavior change from the old exact-string-equality check
    // (which would have removed both, since neither equals the target
    // string), but a harmless one: a wildcard/empty override was never a
    // meaningful pin to begin with.
    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!.a).toBe('*');
    expect(pkgJson.pnpm!.overrides!.b).toBe('');
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
    writePkgJson(dir, { name: 'proj', pnpm: { overrides: { postcss: '>=8.5.23' } } });
    writeInstalledVersion(dir, 'postcss', '8.5.30');

    cleanStaleOverrides(dir, 'pnpm', 'test-project');

    const pkgJson = readPkgJson(dir);
    expect(pkgJson.pnpm!.overrides!.postcss).toBe('>=8.5.23');
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
