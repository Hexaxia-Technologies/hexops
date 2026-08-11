import { existsSync, readFileSync, writeFileSync } from 'fs';
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
 * Convert a concrete target version into a caret ("floor") range so that
 * package-manager overrides stop hard-pinning the fleet to a single exact
 * version forever (see #postcss-floor-audit: 29/32 projects were stuck on an
 * exact postcss pin that blocked routine updates past a vulnerable version).
 *
 * - Concrete versions ("8.5.26") become a caret floor ("^8.5.26") so a normal
 *   `update` can still move the resolved version forward within the same
 *   major line, but never below the floor.
 * - Dist-tags ("latest", "next", "canary") and anything else that isn't a
 *   single concrete semver (including ranges that are already ranges) pass
 *   through unchanged — you cannot caret a tag, and re-wrapping an existing
 *   range would be wrong.
 * - Prereleases ("1.0.0-beta.1") are floored the same way as any other
 *   concrete version. `^1.0.0-beta.1` only matches later prereleases of the
 *   *same* major.minor.patch plus the eventual stable 1.0.0 release — it will
 *   not reach into a different prerelease line. That's inherent to how npm's
 *   semver treats prerelease tags (a range only admits a prerelease that
 *   shares [major,minor,patch] with one of its comparators), not something
 *   this function can or should work around. A prerelease override is
 *   already a narrow, deliberate pin, so that narrower floor is the correct
 *   behavior rather than a special case to avoid.
 */
export function toFloorRange(version: string): string {
  const parsed = semver.valid(version, { loose: true });
  return parsed ? `^${parsed}` : version;
}

/**
 * Whether an installed version satisfies a target that applyOverrides wrote
 * as a floor. For concrete targets, "installed >= target" counts as success
 * — resolving higher than the floor is the point, not a mismatch. Falls back
 * to exact string equality when either side isn't a parseable concrete
 * version (dist-tag targets like "latest"), matching the pre-floor behavior.
 */
function meetsFloorTarget(installedVersion: string | undefined, targetVersion: string): boolean {
  if (!installedVersion) return false;
  const installed = semver.valid(installedVersion, { loose: true });
  const target = semver.valid(targetVersion, { loose: true });
  if (installed && target) return semver.gte(installed, target);
  return installedVersion === targetVersion;
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
    // Once applyOverrides writes floors ("^8.5.23") instead of exact pins,
    // a plain string comparison against the new target ("8.5.26") is always
    // unequal — that would delete the very floor we just wrote, on every
    // subsequent direct-dep update. Test satisfaction instead: keep the
    // existing range if the new target already falls within it.
    const conflictsWithTarget = (pinned: string, targetVersion: string, isFloating: boolean): boolean => {
      if (isFloating) return true; // latest/next/canary always force a fresh, unpinned resolution
      const range = semver.validRange(pinned, { loose: true });
      const target = semver.valid(targetVersion, { loose: true });
      if (range && target) {
        return !semver.satisfies(target, range, { loose: true, includePrerelease: true });
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
          // override (the "^8.5.23" floors this file now writes) resolving
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
          const p = join(cwd, 'node_modules', pkg.name, 'package.json');
          if (!existsSync(p)) return false;
          const installedVersion = JSON.parse(readFileSync(p, 'utf-8')).version;
          return meetsFloorTarget(installedVersion, pkg.targetVersion);
        } catch { return false; }
      });
      if (!anyResolved) throw new Error(err.stderr || err.message || 'Install after override failed');
    }

    for (const pkg of overridePkgs) {
      let verifyWarning = '';
      try {
        const installedPkgPath = join(cwd, 'node_modules', pkg.name, 'package.json');
        if (existsSync(installedPkgPath)) {
          const installedVersion = JSON.parse(readFileSync(installedPkgPath, 'utf-8')).version;
          // With a caret floor written instead of an exact pin, resolving to
          // something newer than the target is success, not a mismatch — the
          // floor did its job. Only warn when the resolved version doesn't
          // meet the floor (or, for dist-tag targets, isn't an exact match,
          // same as the pre-floor behavior).
          if (!meetsFloorTarget(installedVersion, pkg.targetVersion)) {
            verifyWarning = ` ⚠ override written but ${pkg.name} resolved to ${installedVersion} — may need lockfile reset`;
            logger.warn('patches', 'override_version_mismatch', `Override for ${pkg.name}: expected ${pkg.targetVersion}, got ${installedVersion}`, {
              projectId,
              meta: { package: pkg.name, expected: pkg.targetVersion, actual: installedVersion },
            });
          }
        }
      } catch { /* non-fatal */ }

      results.push({
        package: pkg.name,
        success: true,
        output: `Applied override: ${pkg.name}@${pkg.targetVersion}${verifyWarning}\n${installOutput}`,
      });

      logger.info('patches', 'override_applied', `Applied override for ${pkg.name}@${pkg.targetVersion}`, {
        projectId,
        meta: { package: pkg.name, fromVersion: pkg.fromVersion || 'unknown', toVersion: pkg.targetVersion, packageManager, mechanism: 'override' },
      });

      addPatchHistoryEntry({
        id: generatePatchId(),
        timestamp: new Date().toISOString(),
        projectId,
        package: pkg.name,
        fromVersion: pkg.fromVersion || 'unknown',
        toVersion: pkg.targetVersion,
        updateType: pkg.fromVersion ? getUpdateType(pkg.fromVersion, pkg.targetVersion) : 'patch',
        trigger: 'manual',
        success: true,
        output: `Override applied: ${pkg.name}@${pkg.targetVersion}${verifyWarning}`,
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
