import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import semver from 'semver';
import { execAsync, NPM_INSTALL_TIMEOUT, type UpdatePackage, type UpdateResult } from './common';
import { addPatchHistoryEntry, generatePatchId } from '@/lib/patch-storage';
import { getUpdateType } from '@/lib/patch-scanner';
import { logger } from '@/lib/logger';

function pkgJsonIndent(raw: string): string {
  return raw.match(/^(\s+)/m)?.[1] || '  ';
}

/**
 * Convert a concrete target version into a `>=` ("floor") range so that
 * package-manager overrides stop hard-pinning the fleet to a single exact
 * version forever (see #postcss-floor-audit: 29/32 projects were stuck on an
 * exact postcss pin that blocked routine updates past a vulnerable version).
 *
 * Uses a bare `>=` floor, not a caret, by deliberate choice (owner decision):
 * - Caret is inert below 1.0.0. `^0.0.3` expands to `>=0.0.3 <0.0.4-0` —
 *   exactly one version, byte-identical in effect to the exact pin this
 *   change exists to eliminate. `^0.5.1` caps at `<0.6.0-0`, and in the 0.x
 *   line the *minor* is the breaking axis, so that cap is still too tight.
 * - Caret also has a ceiling at the next major, so it can never admit a fix
 *   that ships in a later major version — exactly the scenario a security
 *   floor needs to survive.
 * - `>=` matches the convention already used elsewhere in this repo's own
 *   `package.json` overrides (`esbuild: ">=0.28.1"`, `qs`, `hono`, `ws`).
 *
 * - Concrete versions ("8.5.26") become a floor (">=8.5.26") so a normal
 *   `update` can still move the resolved version forward with no ceiling at
 *   all, but never below the floor.
 * - Dist-tags ("latest", "next", "canary") and anything else that isn't a
 *   single concrete semver (including ranges that are already ranges) pass
 *   through unchanged — you cannot floor a tag, and re-wrapping an existing
 *   range would be wrong.
 * - Prereleases ("1.0.0-beta.1") are floored the same way as any other
 *   concrete version. `>=1.0.0-beta.1` has no upper bound at all, so it
 *   matches every later stable release (1.9.4, 2.5.0, ...) exactly like a
 *   normal `>=` floor would. The one narrowing that still applies is npm
 *   semver's prerelease-tuple rule: a *prerelease* candidate (not a stable
 *   release) only satisfies the range if it shares [major,minor,patch] with
 *   a prerelease comparator already in the range — so `1.0.0-beta.5` and
 *   `1.0.0-rc.1` satisfy it, but `2.0.0-alpha.1` does not. That's inherent
 *   to how npm's semver treats prerelease tags, not something this function
 *   can or should work around.
 */
export function toFloorRange(version: string): string {
  const parsed = semver.valid(version, { loose: true });
  return parsed ? `>=${parsed}` : version;
}

/** The range applyOverrides actually wrote for a target, parsed for satisfaction checks. */
function writtenRangeInfo(targetVersion: string): { writtenRange: string; range: string | null } {
  const writtenRange = toFloorRange(targetVersion);
  return { writtenRange, range: semver.validRange(writtenRange, { loose: true }) };
}

/**
 * Whether a single installed version satisfies the override value
 * applyOverrides actually wrote for this target — `toFloorRange(targetVersion)`
 * — rather than a plain "installed >= target" scalar comparison.
 *
 * This exists to verify the override actually took effect. A plain scalar
 * comparison is too permissive for that job: a keyed pnpm override
 * (`pkg@>=range`), a workspace catalog entry, or a parent package's own
 * constraint can all steer the resolved version somewhere the override we
 * wrote never sanctioned, and "installed >= target" would still read as
 * success. Testing satisfaction against the exact range we wrote is what
 * makes this a real verification rather than a rubber stamp — while still
 * correctly treating "resolved higher than the floor" as success, since the
 * range itself has no upper bound.
 *
 * Falls back to exact string equality when the written value isn't a
 * parseable range (dist-tag targets like "latest"), matching the pre-floor
 * behavior.
 */
function versionSatisfiesTarget(installedVersion: string, targetVersion: string): boolean {
  const { range } = writtenRangeInfo(targetVersion);
  if (range) return semver.satisfies(installedVersion, range, { loose: true });
  return installedVersion === targetVersion;
}

/** Every installed version, among a set of candidates, that does NOT satisfy the written override. */
function findViolatingVersions(installedVersions: string[], targetVersion: string): string[] {
  return installedVersions.filter(v => !versionSatisfiesTarget(v, targetVersion));
}

function readVersionField(pkgJsonPath: string): string | undefined {
  try {
    if (!existsSync(pkgJsonPath)) return undefined;
    const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    return typeof parsed?.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * pnpm's default node-linker (`isolated`) does not create a root
 * `node_modules/<pkg>` entry for a purely-transitive package — it lives in
 * the content-addressable `.pnpm` virtual store instead, at
 * `node_modules/.pnpm/<name>@<version>[_peerHash]/node_modules/<name>/package.json`
 * (scoped names have their "/" replaced with "+" in the store directory
 * name — confirmed against this repo's own `pnpm list --json` output, e.g.
 * `@vitest/ui` stores as `.pnpm/@vitest+ui@4.1.9_.../node_modules/@vitest/ui`).
 * A root-only `existsSync` check is a silent no-op for exactly this layout —
 * confirmed against a real fleet project (bosun-super-admin) that uses
 * pnpm's default isolated linker and has no root `node_modules/postcss` at
 * all. hexops's own `.npmrc` forces `node-linker=hoisted` (a node-pty
 * workaround), which is why this blind spot never surfaced in local
 * development.
 *
 * Collects every distinct version found in the store, not just the first —
 * the store can (and does) hold multiple copies of the same package at
 * different versions simultaneously. Stopping at the first hit would miss
 * exactly the "top-level fix, vulnerable nested copy survives" class this
 * project already tracks as issue #80.
 */
function findPnpmStoreVersions(cwd: string, pkgName: string): string[] {
  const storeDir = join(cwd, 'node_modules', '.pnpm');
  if (!existsSync(storeDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(storeDir);
  } catch {
    return [];
  }
  const prefix = `${pkgName.replace('/', '+')}@`;
  const versions = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const v = readVersionField(join(storeDir, entry, 'node_modules', pkgName, 'package.json'));
    if (v) versions.add(v);
  }
  return Array.from(versions);
}

/**
 * Every distinct installed version of a package this function can find on
 * disk, across every layout it knows how to read: the flat root
 * `node_modules` (npm/yarn, and pnpm's hoisted node-linker) and pnpm's
 * isolated-linker `.pnpm` virtual store. Synchronous and filesystem-only —
 * no package-manager queries — so it's safe to call from both the
 * install-failure fallback and the main verification path.
 *
 * Deliberately does NOT walk arbitrary nested
 * `node_modules/<parent>/node_modules/<pkg>` paths (the npm/yarn nested-copy
 * shape). That's a materially larger surface already handled elsewhere in
 * this codebase for a different purpose — see `resolveInstalledVersion` in
 * patch-scanner.ts, which uses npm audit's `nodes` hints to target specific
 * nested paths flagged by an audit run. Reimplementing a full recursive walk
 * here, for a verification step that only needs to confirm an override
 * took effect, would be a much bigger change than this fix calls for.
 */
function findAllInstalledVersions(cwd: string, pkgName: string): { root?: string; all: string[] } {
  const root = readVersionField(join(cwd, 'node_modules', pkgName, 'package.json'));
  const all = new Set<string>(findPnpmStoreVersions(cwd, pkgName));
  if (root) all.add(root);
  return { root, all: Array.from(all) };
}

/**
 * Last-resort fallback when the filesystem probe (root + `.pnpm` store)
 * finds nothing at all. That can genuinely mean the override never took
 * effect, but it can also mean a custom store location, a workspace
 * hoisting pattern, or some other layout this file doesn't know how to
 * read filesystem-side. Only attempted for pnpm — the concretely-identified
 * blind spot (bosun-super-admin) — not npm/yarn: those always hoist flatly
 * by design, so the root `node_modules` check already covers the
 * overwhelming majority of real layouts there, and taking on `npm ls`
 * output-parsing quirks wasn't warranted for this fix.
 *
 * Parses `pnpm list <pkg> --json --depth Infinity` by walking
 * `dependencies`/`devDependencies`/`optionalDependencies` at every level and
 * collecting `.version` only where the enclosing key equals the package
 * name being looked up (verified against this repo's own real output —
 * blindly collecting every "version" field anywhere in the tree would also
 * pick up unrelated ancestor packages' own versions).
 */
async function queryPnpmForVersions(cwd: string, pkgName: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`pnpm list ${pkgName} --json --depth Infinity`, { cwd, timeout: 15000 });
    const versions = new Set<string>();
    const visit = (node: unknown, key?: string): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item, key);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (key === pkgName && typeof obj.version === 'string' && semver.valid(obj.version, { loose: true })) {
        versions.add(obj.version);
      }
      for (const depsField of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const deps = obj[depsField];
        if (deps && typeof deps === 'object') {
          for (const [depName, depNode] of Object.entries(deps as Record<string, unknown>)) {
            visit(depNode, depName);
          }
        }
      }
    };
    visit(JSON.parse(stdout));
    return Array.from(versions);
  } catch {
    return [];
  }
}

/**
 * Full resolved-version lookup used by the post-install verification path:
 * filesystem probe first (root + `.pnpm` store, covers the concretely
 * identified isolated-linker blind spot), then a `pnpm list` fallback only
 * when the filesystem probe is completely empty. `verified: false` means
 * neither method found anything — genuinely inconclusive, not "assume fine"
 * and not "assume failed". Callers must handle that state explicitly rather
 * than letting it fall through as a silent pass, which is the exact defect
 * this replaces (a bare `existsSync(node_modules/<pkg>)` check that quietly
 * no-ops — no warning, `success: true` — on any project using pnpm's
 * default isolated linker).
 */
async function resolveInstalledVersions(
  cwd: string,
  pkgName: string,
  packageManager: string,
): Promise<{ root?: string; versions: string[]; verified: boolean }> {
  const fsResult = findAllInstalledVersions(cwd, pkgName);
  if (fsResult.all.length > 0) return { root: fsResult.root, versions: fsResult.all, verified: true };
  if (packageManager === 'pnpm') {
    const cliVersions = await queryPnpmForVersions(cwd, pkgName);
    if (cliVersions.length > 0) return { root: undefined, versions: cliVersions, verified: true };
  }
  return { root: undefined, versions: [], verified: false };
}

/** Remove override/resolution entries that conflict with a direct-dep update. */
export function removeOverrideConflicts(
  pkgJsonPath: string,
  directPkgs: UpdatePackage[],
  packageManager: string,
  projectId: string,
): void {
  try {
    const raw = readFileSync(pkgJsonPath, 'utf-8');
    const pkgJson = JSON.parse(raw);
    const pnpmOverrides: Record<string, string> | undefined = pkgJson?.pnpm?.overrides;
    const npmOverrides: Record<string, string> | undefined = pkgJson?.overrides;
    const yarnResolutions: Record<string, string> | undefined = pkgJson?.resolutions;
    let changed = false;

    // An existing override/resolution is only a "conflict" with the incoming
    // direct-dep update if it would actually block that update from landing.
    // Once applyOverrides writes floors (">=8.5.23") instead of exact pins,
    // a plain string comparison against the new target ("8.5.26") is always
    // unequal — that would delete the very floor we just wrote, on every
    // subsequent direct-dep update. Test satisfaction instead: keep the
    // existing range if the new target already falls within it.
    const conflictsWithTarget = (pinned: string, targetVersion: string, isFloating: boolean): boolean => {
      if (isFloating) return true; // latest/next/canary always force a fresh, unpinned resolution
      const range = semver.validRange(pinned, { loose: true });
      const target = semver.valid(targetVersion, { loose: true });
      if (range && target) {
        // No includePrerelease here: npm/pnpm evaluate override ranges
        // without that flag when resolving, so this check has to match
        // resolver semantics, not be more permissive than the actual
        // resolution the range will ever be subjected to.
        return !semver.satisfies(target, range, { loose: true });
      }
      // Either side isn't parseable semver (e.g. an npm "$pkg" alias or a git
      // URL) — fall back to the original strict string comparison so those
      // unusual specifiers keep their prior, well-understood behavior.
      return pinned !== targetVersion;
    };

    for (const pkg of directPkgs) {
      const isFloating = /^(latest|next|canary)$/.test(pkg.targetVersion);
      if (pnpmOverrides?.[pkg.name] !== undefined) {
        const pinned = pnpmOverrides[pkg.name];
        if (conflictsWithTarget(pinned, pkg.targetVersion, isFloating)) {
          delete pkgJson.pnpm.overrides[pkg.name];
          changed = true;
          logger.info('patches', 'override_conflict_removed', `Removed conflicting pnpm.overrides[${pkg.name}]=${pinned} before updating to ${pkg.targetVersion}`, { projectId, meta: { package: pkg.name } });
        }
      }
      if (npmOverrides?.[pkg.name] !== undefined) {
        const pinned = npmOverrides[pkg.name];
        if (conflictsWithTarget(pinned, pkg.targetVersion, isFloating)) {
          delete pkgJson.overrides[pkg.name];
          changed = true;
          logger.info('patches', 'override_conflict_removed', `Removed conflicting overrides[${pkg.name}]=${pinned} before updating to ${pkg.targetVersion}`, { projectId, meta: { package: pkg.name } });
        }
      }
      if (yarnResolutions?.[pkg.name] !== undefined) {
        const pinned = yarnResolutions[pkg.name];
        if (conflictsWithTarget(pinned, pkg.targetVersion, isFloating)) {
          delete pkgJson.resolutions[pkg.name];
          changed = true;
          logger.info('patches', 'override_conflict_removed', `Removed conflicting resolutions[${pkg.name}]=${pinned} before updating to ${pkg.targetVersion}`, { projectId, meta: { package: pkg.name } });
        }
      }
    }

    if (changed) writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, pkgJsonIndent(raw)) + '\n', 'utf-8');
  } catch {
    // Non-fatal
  }
}

/** Remove override entries where the installed version is already newer than the pin. */
export function cleanStaleOverrides(
  cwd: string,
  packageManager: string,
  projectId: string,
): void {
  try {
    const pkgJsonPath = join(cwd, 'package.json');
    const raw = readFileSync(pkgJsonPath, 'utf-8');
    const pkgJson = JSON.parse(raw);

    const overridesObj: Record<string, string> | undefined =
      packageManager === 'pnpm' ? pkgJson?.pnpm?.overrides :
      packageManager === 'npm' ? pkgJson?.overrides :
      pkgJson?.resolutions;

    if (!overridesObj || Object.keys(overridesObj).length === 0) return;

    const staleKeys: string[] = [];
    for (const [overridePkg, pinnedVersion] of Object.entries(overridesObj)) {
      try {
        // pnpm allows keys like "pkg@>=range" or "@scope/pkg@>=range" — strip specifier for lookup
        const atIdx = overridePkg.indexOf('@', 1); // skip leading @ for scoped packages
        const lookupPkg = atIdx !== -1 ? overridePkg.slice(0, atIdx) : overridePkg;
        const nmPath = join(cwd, 'node_modules', lookupPkg, 'package.json');
        if (existsSync(nmPath)) {
          const installed = JSON.parse(readFileSync(nmPath, 'utf-8')).version;
          // Only exact pins ("8.5.15") are ever candidates for staleness
          // removal here — deliberately, not incidentally. A range-valued
          // override (the ">=8.5.23" floors this file now writes) resolving
          // to something newer than its base is the expected, desired
          // outcome, not staleness: the floor is still doing its job of
          // keeping the fleet off the vulnerable version. Removing it would
          // strip that security floor entirely. So range-shaped values
          // (anything starting with <, >, =, ^, or ~) are skipped outright,
          // same as before — only bare exact versions are compared.
          if (installed && pinnedVersion && !/^[<>=^~]/.test(pinnedVersion)) {
            const iv = semver.valid(installed, { loose: true });
            const pv = semver.valid(pinnedVersion, { loose: true });
            // Proper semver comparison instead of hand-rolled parseInt
            // splitting, which mishandled prereleases (1.0.0-beta.1 vs
            // 1.0.0) and build metadata (1.0.0+build vs 1.0.0). If either
            // side isn't a parseable concrete version, skip rather than
            // guess — the old code silently treated unparseable segments as
            // 0, which could misfire as "newer" on garbage input.
            if (iv && pv && semver.gt(iv, pv)) staleKeys.push(overridePkg);
          }
        }
      } catch { /* skip entry */ }
    }

    if (staleKeys.length > 0) {
      for (const key of staleKeys) delete overridesObj[key];
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, pkgJsonIndent(raw)) + '\n', 'utf-8');
      logger.info('patches', 'stale_overrides_removed', `Removed ${staleKeys.length} stale override(s): ${staleKeys.join(', ')}`, {
        projectId,
        meta: { removed: staleKeys },
      });
    }
  } catch {
    // Non-fatal
  }
}

/** Apply package manager overrides for transitive dependencies. */
export async function applyOverrides(
  overridePkgs: UpdatePackage[],
  packageManager: string,
  cwd: string,
  projectId: string,
): Promise<UpdateResult[]> {
  const results: UpdateResult[] = [];

  // Resolve "resolve-latest" versions
  for (const pkg of overridePkgs) {
    if (pkg.targetVersion === 'resolve-latest') {
      try {
        const viewCmd = packageManager === 'pnpm'
          ? `pnpm view ${pkg.name} version`
          : packageManager === 'yarn'
          ? `yarn info ${pkg.name} version`
          : `npm view ${pkg.name} version`;
        const { stdout } = await execAsync(viewCmd, { cwd, timeout: 15000 });
        const resolved = stdout.trim();
        pkg.targetVersion = resolved && /^\d+\.\d+\.\d+/.test(resolved) ? resolved : 'latest';
      } catch {
        pkg.targetVersion = 'latest';
      }
    }
  }

  try {
    const pkgJsonPath = join(cwd, 'package.json');
    const pkgJsonRaw = readFileSync(pkgJsonPath, 'utf-8');
    const pkgJson = JSON.parse(pkgJsonRaw);

    if (packageManager === 'pnpm') {
      if (!pkgJson.pnpm) pkgJson.pnpm = {};
      if (!pkgJson.pnpm.overrides) pkgJson.pnpm.overrides = {};
      for (const pkg of overridePkgs) pkgJson.pnpm.overrides[pkg.name] = toFloorRange(pkg.targetVersion);
    } else if (packageManager === 'npm') {
      if (!pkgJson.overrides) pkgJson.overrides = {};
      for (const pkg of overridePkgs) {
        if (pkgJson.dependencies?.[pkg.name] !== undefined) {
          // Direct dependency: npm can't apply `overrides` to a package that's
          // also a direct dependency, so the only way to move it is to rewrite
          // the direct specifier itself. That specifier is exactly as prone to
          // the "exact pin blocks future updates" problem this whole change
          // exists to fix, so it gets the same floor treatment as the
          // override-only path below — not left as an exact pin silently.
          pkgJson.dependencies[pkg.name] = toFloorRange(pkg.targetVersion);
        } else {
          if (pkgJson.devDependencies?.[pkg.name] !== undefined) delete pkgJson.devDependencies[pkg.name];
          pkgJson.overrides[pkg.name] = toFloorRange(pkg.targetVersion);
        }
      }
    } else {
      if (!pkgJson.resolutions) pkgJson.resolutions = {};
      for (const pkg of overridePkgs) pkgJson.resolutions[pkg.name] = toFloorRange(pkg.targetVersion);
    }

    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, pkgJsonIndent(pkgJsonRaw)) + '\n', 'utf-8');

    const installCmd = packageManager === 'pnpm'
      ? 'pnpm install --no-frozen-lockfile'
      : packageManager === 'npm'
      ? 'npm install --legacy-peer-deps'
      : 'yarn install';

    let installOutput = '';
    try {
      const installResult = await execAsync(installCmd, { cwd, timeout: NPM_INSTALL_TIMEOUT });
      installOutput = `$ ${installCmd}\n${installResult.stdout || ''}${installResult.stderr || ''}`;
    } catch (installErr) {
      const err = installErr as { stdout?: string; stderr?: string; message?: string };
      installOutput = `$ ${installCmd}\n${err.stdout || ''}${err.stderr || ''}`;
      const anyResolved = overridePkgs.some(pkg => {
        try {
          // Filesystem-only probe (root + pnpm's .pnpm store) — no CLI
          // fallback here. This runs only after the install command itself
          // already failed; on ambiguity it's safer for this specific path
          // to fall through to "not resolved" (favoring reporting the
          // failure) than to spend another child-process round-trip trying
          // to rescue an already-failing install.
          const { all } = findAllInstalledVersions(cwd, pkg.name);
          return all.some(v => {
            // A version on disk that's identical to what was installed
            // BEFORE this override ran is not evidence the install
            // succeeded — it's evidence the install failed and left the
            // pre-existing tree untouched. Without this guard, a failed
            // install (registry 5xx, ERESOLVE, disk full) with a
            // stale-but-already-satisfying copy already in node_modules
            // would get silently swallowed here, every package in this
            // batch would report success, and the caller would go on to
            // reconcile/audit a tree whose install never actually
            // completed.
            if (pkg.fromVersion && v === pkg.fromVersion) return false;
            return versionSatisfiesTarget(v, pkg.targetVersion);
          });
        } catch { return false; }
      });
      if (!anyResolved) throw new Error(err.stderr || err.message || 'Install after override failed');
    }

    for (const pkg of overridePkgs) {
      let verifyWarning = '';
      let resolvedVersion: string | undefined;
      const { writtenRange } = writtenRangeInfo(pkg.targetVersion);
      try {
        // Isolated-layout-aware lookup (root node_modules, then the .pnpm
        // store, then — for pnpm only — a `pnpm list` fallback). This is
        // the only mechanism that catches project issue #126 (a bare
        // floor failing to move the resolved version), so it has to
        // actually run on the layout the project uses, not just the
        // hoisted layout this worktree happens to force via .npmrc.
        const probe = await resolveInstalledVersions(cwd, pkg.name, packageManager);

        if (!probe.verified) {
          // Could not find this package by ANY method — root, .pnpm store,
          // or (for pnpm) a live query. This must be surfaced as "couldn't
          // verify", not silently folded into "no warning = fine". Treating
          // an inconclusive probe as success is exactly the defect being
          // fixed: a root-only existsSync check that quietly no-ops on any
          // project using pnpm's default isolated linker.
          verifyWarning = ` ⚠ could not verify ${pkg.name}'s resolved version on disk (checked root node_modules and the pnpm store) — check manually`;
          logger.warn('patches', 'override_verify_inconclusive', `Could not determine an installed version for ${pkg.name} after applying override ${writtenRange} — checked root node_modules and the pnpm store, found nothing`, {
            projectId,
            meta: { package: pkg.name, targetVersion: pkg.targetVersion, writtenRange },
          });
        } else {
          resolvedVersion = probe.root ?? probe.versions.slice().sort(semver.rcompare)[0];

          // Check EVERY discovered copy, not just the one being reported —
          // the .pnpm store (or, in principle, a nested npm copy) can hold
          // several versions of the same package at once, and a floor
          // satisfied at the root with a vulnerable copy still nested
          // elsewhere is exactly the false-clear class this project already
          // tracks as issue #80.
          const violating = findViolatingVersions(probe.versions, pkg.targetVersion);

          if (violating.length > 0) {
            verifyWarning = ` ⚠ override written but ${pkg.name} resolved to ${violating.join(', ')} (does not satisfy ${writtenRange}) — may need lockfile reset`;
            logger.warn('patches', 'override_version_mismatch', `Override for ${pkg.name}: expected ${writtenRange}, found violating cop${violating.length === 1 ? 'y' : 'ies'}: ${violating.join(', ')}`, {
              projectId,
              meta: { package: pkg.name, expected: pkg.targetVersion, writtenRange, violatingVersions: violating, allVersions: probe.versions },
            });
          } else if (resolvedVersion) {
            // Satisfies the floor — not a failure. But a resolved major
            // beyond the one that was targeted is exactly the kind of event
            // a bare `>=` floor (no ceiling, by owner decision) makes
            // possible and that someone should see surfaced in the patch
            // log, not buried silently in a routine "applied" entry.
            const targetSemver = semver.valid(pkg.targetVersion, { loose: true });
            if (targetSemver) {
              const resolvedMajor = semver.major(resolvedVersion);
              const targetMajor = semver.major(targetSemver);
              if (resolvedMajor > targetMajor) {
                logger.warn('patches', 'override_major_jump', `Override for ${pkg.name}: requested ${writtenRange}, resolved to ${resolvedVersion} — a newer major (${resolvedMajor}) than targeted (${targetMajor})`, {
                  projectId,
                  meta: { package: pkg.name, expected: pkg.targetVersion, resolvedVersion, targetMajor, resolvedMajor },
                });
              }
            }
          }
        }
      } catch { /* non-fatal */ }

      const resolvedNote = resolvedVersion ? `, resolved ${resolvedVersion}` : '';

      results.push({
        package: pkg.name,
        success: true,
        output: `Applied override: ${pkg.name}@${writtenRange}${resolvedNote}${verifyWarning}\n${installOutput}`,
        resolvedVersion,
      });

      logger.info('patches', 'override_applied', `Applied override for ${pkg.name}@${writtenRange}${resolvedNote}`, {
        projectId,
        meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, resolvedVersion, packageManager, mechanism: 'override' },
      });

      addPatchHistoryEntry({
        id: generatePatchId(),
        timestamp: new Date().toISOString(),
        projectId,
        package: pkg.name,
        fromVersion: pkg.fromVersion || 'unknown',
        toVersion: pkg.targetVersion,
        resolvedVersion,
        updateType: pkg.fromVersion ? getUpdateType(pkg.fromVersion, pkg.targetVersion) : 'patch',
        trigger: 'manual',
        success: true,
        output: `Override applied: ${pkg.name}@${writtenRange}${resolvedNote}${verifyWarning}`,
      });
    }
  } catch (err) {
    const msg = (err as { message?: string }).message;
    for (const pkg of overridePkgs) {
      results.push({ package: pkg.name, success: false, output: '', error: `Failed to apply override: ${msg}` });
      logger.error('patches', 'override_failed', `Failed to apply override for ${pkg.name}: ${msg}`, {
        projectId,
        meta: { package: pkg.name },
      });
    }
  }

  return results;
}
