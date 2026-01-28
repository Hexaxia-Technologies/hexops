import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type {
  PatchState,
  PatchHistory,
  PatchHistoryEntry,
  ProjectPatchCache,
  ProjectPatchState,
} from './types';

// Storage paths
const PATCHES_DIR = join(process.cwd(), '.hexops', 'patches');
const CACHE_DIR = join(PATCHES_DIR, 'cache');
const STATE_FILE = join(PATCHES_DIR, 'state.json');
const HISTORY_FILE = join(PATCHES_DIR, 'history.json');

// Cache TTL: 1 hour base + up to 15 min jitter to prevent thundering herd
const CACHE_TTL_BASE_MS = 60 * 60 * 1000;
const CACHE_TTL_JITTER_MS = 15 * 60 * 1000;

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
 * Get cache file path for a project
 */
function getCacheFilePath(projectId: string): string {
  return join(CACHE_DIR, `${projectId}.json`);
}

/**
 * Read project cache (returns null if expired or missing)
 */
export function readProjectCache(projectId: string): ProjectPatchCache | null {
  ensurePatchStorageDir();
  const cacheFile = getCacheFilePath(projectId);
  if (!existsSync(cacheFile)) {
    return null;
  }
  try {
    const content = readFileSync(cacheFile, 'utf-8');
    const cache: ProjectPatchCache = JSON.parse(content);
    // Check if expired
    if (new Date(cache.expiresAt) < new Date()) {
      return null;
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
  vulnerabilities: ProjectPatchCache['vulnerabilities']
): ProjectPatchCache {
  const now = new Date();
  return {
    projectId,
    timestamp: now.toISOString(),
    expiresAt: new Date(now.getTime() + getCacheTTL()).toISOString(),
    outdated,
    vulnerabilities,
  };
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
