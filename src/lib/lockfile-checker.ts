import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { detectPackageManager } from './patch-scanner';

export interface LockfileMismatch {
  package: string;
  packageJsonSpec: string;
  lockfileSpec: string;
  section: 'dependencies' | 'devDependencies';
}

export interface LockfileCheckResult {
  fresh: boolean;
  mismatches: LockfileMismatch[];
  lockfileType: 'pnpm' | 'npm' | 'yarn' | null;
}

/**
 * Check if lock file specs match package.json specs.
 * Stale lock files cause deploy failures on Vercel/CI (--frozen-lockfile).
 */
export function checkLockFileFreshness(projectPath: string): LockfileCheckResult {
  const pm = detectPackageManager(projectPath);

  const pkgJsonPath = join(projectPath, 'package.json');
  if (!existsSync(pkgJsonPath)) return { fresh: true, mismatches: [], lockfileType: pm };

  let pkgJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
    pnpm?: { overrides?: Record<string, string> };
    resolutions?: Record<string, string>;
  };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  } catch {
    return { fresh: true, mismatches: [], lockfileType: pm };
  }

  // Collect packages that have a package manager override/resolution.
  // When an override exists, pnpm/npm records the OVERRIDE spec in the lockfile
  // (not the direct dep spec), so a mismatch is expected and not a stale lockfile.
  const overriddenPackages = new Set<string>([
    ...Object.keys(pkgJson.pnpm?.overrides || {}),
    ...Object.keys(pkgJson.overrides || {}),
    ...Object.keys(pkgJson.resolutions || {}),
  ]);

  const allDeps: Record<string, { spec: string; section: 'dependencies' | 'devDependencies' }> = {};
  for (const [name, spec] of Object.entries(pkgJson.dependencies || {})) {
    allDeps[name] = { spec, section: 'dependencies' };
  }
  for (const [name, spec] of Object.entries(pkgJson.devDependencies || {})) {
    allDeps[name] = { spec, section: 'devDependencies' };
  }

  let lockfileSpecs: Record<string, string>;
  try {
    if (pm === 'pnpm') {
      lockfileSpecs = parsePnpmLock(projectPath);
    } else if (pm === 'npm') {
      lockfileSpecs = parseNpmLock(projectPath);
    } else {
      // yarn lock doesn't store specifiers in a simple way
      return { fresh: true, mismatches: [], lockfileType: pm };
    }
  } catch {
    return { fresh: true, mismatches: [], lockfileType: pm };
  }

  const mismatches: LockfileMismatch[] = [];

  for (const [name, { spec, section }] of Object.entries(allDeps)) {
    // Skip packages that have an override — pnpm/npm writes the override spec
    // into the lockfile, not the direct dep spec, so differences are expected.
    if (overriddenPackages.has(name)) continue;

    const lockSpec = lockfileSpecs[name];
    if (lockSpec && lockSpec !== spec) {
      mismatches.push({
        package: name,
        packageJsonSpec: spec,
        lockfileSpec: lockSpec,
        section,
      });
    }
  }

  return {
    fresh: mismatches.length === 0,
    mismatches,
    lockfileType: pm,
  };
}

/**
 * Parse pnpm-lock.yaml to extract specifiers from importers section.
 * Uses simple line parsing to avoid adding a yaml dependency.
 *
 * pnpm lockfile v9 format:
 *   importers:
 *     .:
 *       dependencies:
 *         package-name:
 *           specifier: ^1.2.3
 *           version: 1.2.3
 *
 * Note: indentation varies between lockfile versions. We detect it dynamically.
 */
function parsePnpmLock(projectPath: string): Record<string, string> {
  const lockPath = join(projectPath, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) return {};

  const content = readFileSync(lockPath, 'utf-8');
  const specs: Record<string, string> = {};

  const lines = content.split('\n');
  let inImporters = false;
  let inRoot = false;
  let inDepsSection = false;
  let depsIndent = 0;     // indent level of "dependencies:" line
  let currentPackage: string | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;

    const indent = line.search(/\S/);

    if (trimmed === 'importers:') {
      inImporters = true;
      continue;
    }

    // Exit importers on new top-level key
    if (inImporters && indent === 0 && trimmed !== 'importers:') {
      inImporters = false;
      inRoot = false;
      inDepsSection = false;
      continue;
    }

    if (inImporters && !inRoot && /^\s+\.:/.test(line)) {
      inRoot = true;
      continue;
    }

    if (inRoot) {
      // Check for dependencies: or devDependencies: section
      const depsMatch = trimmed.trim().match(/^(dependencies|devDependencies):$/);
      if (depsMatch) {
        inDepsSection = true;
        depsIndent = indent;
        currentPackage = null;
        continue;
      }

      // If we're in a deps section and hit a line at same indent as dependencies:, exit deps
      if (inDepsSection && indent <= depsIndent && !trimmed.trim().match(/^(dependencies|devDependencies):$/)) {
        inDepsSection = false;
        currentPackage = null;
        // Check if this is another section at root importer level
        if (indent <= 2) {
          inRoot = false;
          continue;
        }
      }

      if (inDepsSection) {
        // Package name: one indent level deeper than dependencies:
        // specifier/version: two indent levels deeper
        const pkgIndent = depsIndent + 2;
        const specIndent = depsIndent + 4;

        if (indent === pkgIndent) {
          // This is a package name line (strip quotes and colon)
          const name = trimmed.trim().replace(/^['"]/, '').replace(/['"]?:.*$/, '').trim();
          if (name !== 'specifier' && name !== 'version') {
            currentPackage = name;
          }
        } else if (indent === specIndent && currentPackage) {
          const specMatch = trimmed.trim().match(/^specifier:\s*['"]?(.+?)['"]?$/);
          if (specMatch) {
            specs[currentPackage] = specMatch[1].trim();
          }
        }
      }
    }
  }

  return specs;
}

/**
 * Parse package-lock.json to extract specs.
 * npm lock v2/v3 stores the spec in packages[""].dependencies
 */
function parseNpmLock(projectPath: string): Record<string, string> {
  const lockPath = join(projectPath, 'package-lock.json');
  if (!existsSync(lockPath)) return {};

  const content = JSON.parse(readFileSync(lockPath, 'utf-8'));
  const specs: Record<string, string> = {};

  // npm lockfile v2/v3: packages[""] contains the root project's deps
  const root = content.packages?.[''] || {};
  for (const [name, spec] of Object.entries(root.dependencies || {})) {
    specs[name] = spec as string;
  }
  for (const [name, spec] of Object.entries(root.devDependencies || {})) {
    specs[name] = spec as string;
  }

  return specs;
}
