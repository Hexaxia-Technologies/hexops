import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import type {
  PatchState,
  PatchHistory,
  PatchHistoryEntry,
  ProjectPatchCache,
  ProjectPatchState,
  ActiveOverride,
} from './types';

// Storage paths
const PATCHES_DIR = join(process.cwd(), '.hexops', 'patches');
const CACHE_DIR = join(PATCHES_DIR, 'cache');
const STATE_FILE = join(PATCHES_DIR, 'state.json');
const HISTORY_FILE = join(PATCHES_DIR, 'history.json');

// Cache TTL: 1 hour base + up to 15 min jitter to prevent thundering herd
const CACHE_TTL_BASE_MS = 60 * 60 * 1000;
const CACHE_TTL_JITTER_MS = 15 * 60 * 1000;

// Bump when the cache schema changes to force automatic invalidation of old entries
const CACHE_SCHEMA_VERSION = 3;

// Lockfiles fingerprinted (alongside package.json) to detect out-of-band dep changes.
// Exported so other server-side code (e.g. the git-commit route's `scope: 'dependencies'`
// resolution) can stage the same file set without redefining it and drifting out of sync.
export const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];

/**
 * Fingerprint a project's dependency state from package.json + its lockfile(s).
 * Lets the scan cache invalidate when deps change OUT OF BAND (manual edits, CLI
 * bumps, dependabot, git pull) rather than only on hexops's own apply-patch paths.
 * Returns null if package.json can't be read (caller then falls back to TTL only).
 */
export function computeDepsFingerprint(projectPath: string): string | null {
  try {
    const hash = createHash('sha1');
    hash.update(readFileSync(join(projectPath, 'package.json')));
    for (const lf of LOCKFILES) {
      const p = join(projectPath, lf);
      if (existsSync(p)) hash.update(readFileSync(p));
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function getCacheTTL(): number {
  return CACHE_TTL_BASE_MS + Math.floor(Math.random() * CACHE_TTL_JITTER_MS);
}

/**
 * Ensure storage directories exist
 */
export function ensurePatchStorageDir(): void {
  if (!existsSync(PATCHES_DIR)) {
    mkdirSync(PATCHES_DIR, { recursive: true });
  }
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Read patch state (aggregate view)
 */
export function readPatchState(): PatchState {
  ensurePatchStorageDir();
  if (!existsSync(STATE_FILE)) {
    return { lastFullScan: null, projects: {} };
  }
  try {
    const content = readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { lastFullScan: null, projects: {} };
  }
}

/**
 * Write patch state
 */
export function writePatchState(state: PatchState): void {
  ensurePatchStorageDir();
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Ignore write errors
  }
}

/**
 * Update a single project's state
 */
export function updateProjectPatchState(
  projectId: string,
  projectState: ProjectPatchState
): void {
  const state = readPatchState();
  state.projects[projectId] = projectState;
  state.lastFullScan = new Date().toISOString();
  writePatchState(state);
}

/**
 * Read patch history
 */
export function readPatchHistory(): PatchHistory {
  ensurePatchStorageDir();
  if (!existsSync(HISTORY_FILE)) {
    return { updates: [] };
  }
  try {
    const content = readFileSync(HISTORY_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { updates: [] };
  }
}

/**
 * Add entry to patch history
 */
export function addPatchHistoryEntry(entry: PatchHistoryEntry): void {
  ensurePatchStorageDir();
  const history = readPatchHistory();
  history.updates.unshift(entry); // Most recent first
  // Keep last 500 entries
  if (history.updates.length > 500) {
    history.updates = history.updates.slice(0, 500);
  }
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch {
    // Ignore write errors
  }
}

/**
 * Generate unique ID for history entry
 */
export function generatePatchId(): string {
  return `upd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Reconcile patch history for a project against the current scan results.
 *
 * Two checks:
 * 1. Version unchanged — installed version still matches fromVersion, not toVersion.
 *    Catches top-level installs that silently no-oped.
 * 2. Still vulnerable — package still appears in the live advisory list from the scan.
 *    Catches nested-copy false positives (e.g. next pinning postcss@8.4.31 internally)
 *    that a top-level node_modules check can never detect.
 *
 * @param projectId - The project to reconcile
 * @param installedVersions - Map of package name -> currently installed version
 * @param stillVulnerablePackages - Set of package names that still appear in the current audit
 */
export function reconcilePatchHistory(
  projectId: string,
  installedVersions: Record<string, string>,
  stillVulnerablePackages: Set<string> = new Set(),
): number {
  const history = readPatchHistory();
  let corrected = 0;

  for (const entry of history.updates) {
    if (entry.projectId !== projectId) continue;
    if (!entry.success) continue;

    // Check 1: advisory still present → nested copy survived the patch
    if (stillVulnerablePackages.has(entry.package)) {
      entry.success = false;
      entry.error = `Retroactively marked failed: ${entry.package} still appears as vulnerable after patch (nested copy may have survived the override)`;
      corrected++;
      continue;
    }

    // Check 2: top-level version unchanged → install silently no-oped
    const installed = installedVersions[entry.package];
    if (!installed) continue;
    if (installed === entry.fromVersion && installed !== entry.toVersion) {
      entry.success = false;
      entry.error = `Retroactively marked failed: ${entry.package} still at ${installed} (expected ${entry.toVersion})`;
      corrected++;
    }
  }

  if (corrected > 0) {
    try {
      writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch {
      // Ignore write errors
    }
  }

  return corrected;
}

/**
 * Get cache file path for a project
 */
function getCacheFilePath(projectId: string): string {
  return join(CACHE_DIR, `${projectId}.json`);
}

/**
 * Read project cache (returns null if expired, missing, or wrong schema version)
 */
export function readProjectCache(projectId: string, projectPath?: string): ProjectPatchCache | null {
  ensurePatchStorageDir();
  const cacheFile = getCacheFilePath(projectId);
  if (!existsSync(cacheFile)) {
    return null;
  }
  try {
    const content = readFileSync(cacheFile, 'utf-8');
    const cache: ProjectPatchCache & { schemaVersion?: number } = JSON.parse(content);
    // Reject caches written before the current schema version
    if ((cache.schemaVersion ?? 1) < CACHE_SCHEMA_VERSION) {
      return null;
    }
    // Check if expired
    if (new Date(cache.expiresAt) < new Date()) {
      return null;
    }
    // Content-aware invalidation: even within its TTL, the cache is stale if the
    // project's deps changed out of band since it was written.
    if (projectPath && cache.depsFingerprint) {
      const current = computeDepsFingerprint(projectPath);
      if (current && current !== cache.depsFingerprint) {
        return null;
      }
    }
    return cache;
  } catch {
    return null;
  }
}

/**
 * Write project cache
 */
export function writeProjectCache(cache: ProjectPatchCache): void {
  ensurePatchStorageDir();
  const cacheFile = getCacheFilePath(cache.projectId);
  try {
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore write errors
  }
}

/**
 * Create a new cache entry with TTL
 */
export function createProjectCache(
  projectId: string,
  outdated: ProjectPatchCache['outdated'],
  vulnerabilities: ProjectPatchCache['vulnerabilities'],
  activeOverrides?: ActiveOverride[],
  projectPath?: string
): ProjectPatchCache {
  const now = new Date();
  const depsFingerprint = projectPath ? computeDepsFingerprint(projectPath) : null;
  return {
    projectId,
    timestamp: now.toISOString(),
    expiresAt: new Date(now.getTime() + getCacheTTL()).toISOString(),
    outdated,
    vulnerabilities,
    ...(activeOverrides && activeOverrides.length > 0 ? { activeOverrides } : {}),
    ...(depsFingerprint ? { depsFingerprint } : {}),
    schemaVersion: CACHE_SCHEMA_VERSION,
  } as ProjectPatchCache;
}

/**
 * Invalidate cache for a project
 */
export function invalidateProjectCache(projectId: string): void {
  ensurePatchStorageDir();
  const cacheFile = getCacheFilePath(projectId);
  if (existsSync(cacheFile)) {
    try {
      unlinkSync(cacheFile);
    } catch {
      // Ignore deletion errors
    }
  }
}

/**
 * Clear all project caches
 */
export function clearAllProjectCaches(): void {
  ensurePatchStorageDir();
  if (!existsSync(CACHE_DIR)) return;

  try {
    const files = readdirSync(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          unlinkSync(join(CACHE_DIR, file));
        } catch {
          // Ignore individual deletion errors
        }
      }
    }
  } catch {
    // Ignore read errors
  }
}
