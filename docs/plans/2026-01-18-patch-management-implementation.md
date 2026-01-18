# Patch Management System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a priority-based patch management system with visibility across all projects, context-rich update previews, and history tracking.

**Architecture:** File-based storage in `.hexops/patches/` with JSON files for state, history, and per-project cache. New `/api/patches` endpoints aggregate data across projects. Dedicated Patches page with priority queue UI.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, shadcn/ui

**Design Doc:** `docs/plans/2026-01-18-patch-management-design.md`

---

## Phase 1: Storage Layer & Core API

### Task 1: Add Patch Types

**Files:**
- Modify: `src/lib/types.ts`

**Step 1: Add patch-related type definitions**

Add to end of `src/lib/types.ts`:

```typescript
// Patch Management Types

export type UpdateType = 'patch' | 'minor' | 'major';
export type VulnSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';
export type PatchTrigger = 'manual' | 'auto';

export interface PatchQueueItem {
  priority: number;
  type: 'vulnerability' | 'outdated';
  severity: VulnSeverity | 'major' | 'minor' | 'patch';
  package: string;
  currentVersion: string;
  targetVersion: string;
  updateType: UpdateType;
  affectedProjects: string[];
  title?: string; // For vulnerabilities
  fixAvailable?: boolean;
}

export interface PatchSummary {
  critical: number;
  high: number;
  moderate: number;
  outdatedMajor: number;
  outdatedMinor: number;
  outdatedPatch: number;
}

export interface ProjectPatchState {
  outdatedCount: number;
  vulnCount: number;
  criticalCount: number;
  lastChecked: string; // ISO date
}

export interface PatchState {
  lastFullScan: string | null;
  projects: Record<string, ProjectPatchState>;
}

export interface PatchHistoryEntry {
  id: string;
  timestamp: string;
  projectId: string;
  package: string;
  fromVersion: string;
  toVersion: string;
  updateType: UpdateType;
  trigger: PatchTrigger;
  success: boolean;
  output: string;
  error?: string;
}

export interface PatchHistory {
  updates: PatchHistoryEntry[];
}

export interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  type: 'dependencies' | 'devDependencies';
}

export interface VulnerabilityInfo {
  name: string;
  severity: VulnSeverity;
  title: string;
  path: string;
  fixAvailable: boolean;
  fixVersion?: string;
}

export interface ProjectPatchCache {
  projectId: string;
  timestamp: string;
  expiresAt: string;
  outdated: OutdatedPackage[];
  vulnerabilities: VulnerabilityInfo[];
}
```

**Step 2: Verify types compile**

Run: `cd /home/aaron/Projects/hexops && pnpm build`
Expected: Build succeeds without type errors

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(patches): add patch management type definitions"
```

---

### Task 2: Create Patch Storage Module

**Files:**
- Create: `src/lib/patch-storage.ts`

**Step 1: Create the storage module**

Create `src/lib/patch-storage.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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

// Cache TTL: 1 hour
const CACHE_TTL_MS = 60 * 60 * 1000;

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
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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
  const history = readPatchHistory();
  history.updates.unshift(entry); // Most recent first
  // Keep last 500 entries
  if (history.updates.length > 500) {
    history.updates = history.updates.slice(0, 500);
  }
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
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
  writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
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
    expiresAt: new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
    outdated,
    vulnerabilities,
  };
}

/**
 * Invalidate cache for a project
 */
export function invalidateProjectCache(projectId: string): void {
  const cacheFile = getCacheFilePath(projectId);
  if (existsSync(cacheFile)) {
    try {
      const fs = require('fs');
      fs.unlinkSync(cacheFile);
    } catch {
      // Ignore deletion errors
    }
  }
}
```

**Step 2: Verify module compiles**

Run: `cd /home/aaron/Projects/hexops && pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/lib/patch-storage.ts
git commit -m "feat(patches): add file-based patch storage module"
```

---

### Task 3: Create Patch Scanner Module

**Files:**
- Create: `src/lib/patch-scanner.ts`

**Step 1: Create the scanner module**

Create `src/lib/patch-scanner.ts`:

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import type {
  ProjectConfig,
  OutdatedPackage,
  VulnerabilityInfo,
  VulnSeverity,
  UpdateType,
  PatchQueueItem,
  PatchSummary,
  ProjectPatchCache,
} from './types';
import {
  readProjectCache,
  writeProjectCache,
  createProjectCache,
  updateProjectPatchState,
} from './patch-storage';

const execAsync = promisify(exec);

type PackageManager = 'pnpm' | 'npm' | 'yarn';

/**
 * Detect package manager from lockfile
 */
export function detectPackageManager(projectPath: string): PackageManager | null {
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'package-lock.json'))) return 'npm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  return null;
}

/**
 * Determine update type from version strings
 */
export function getUpdateType(current: string, target: string): UpdateType {
  const cleanCurrent = current.replace(/^[\^~]/, '');
  const cleanTarget = target.replace(/^[\^~]/, '');

  const [currMajor, currMinor] = cleanCurrent.split('.').map(Number);
  const [targMajor, targMinor] = cleanTarget.split('.').map(Number);

  if (targMajor > currMajor) return 'major';
  if (targMinor > currMinor) return 'minor';
  return 'patch';
}

/**
 * Scan a project for outdated packages
 */
export async function scanOutdated(
  project: ProjectConfig
): Promise<OutdatedPackage[]> {
  const pm = detectPackageManager(project.path);
  if (!pm) return [];

  try {
    let output = '';
    const cmd = pm === 'pnpm'
      ? 'pnpm outdated --format json'
      : pm === 'npm'
      ? 'npm outdated --json'
      : 'yarn outdated --json';

    try {
      const { stdout } = await execAsync(cmd, { cwd: project.path });
      output = stdout;
    } catch (err: unknown) {
      // These commands exit non-zero when outdated packages exist
      const execErr = err as { stdout?: string };
      output = execErr.stdout || '{}';
    }

    const data = JSON.parse(output || '{}');
    const result: OutdatedPackage[] = [];

    // pnpm format (array)
    if (Array.isArray(data)) {
      for (const pkg of data) {
        result.push({
          name: pkg.name,
          current: pkg.current,
          wanted: pkg.wanted,
          latest: pkg.latest,
          type: pkg.dependencyType === 'devDependencies' ? 'devDependencies' : 'dependencies',
        });
      }
    }
    // npm format (object)
    else if (typeof data === 'object') {
      for (const [name, info] of Object.entries(data)) {
        const pkg = info as { current: string; wanted: string; latest: string };
        result.push({
          name,
          current: pkg.current,
          wanted: pkg.wanted,
          latest: pkg.latest,
          type: 'dependencies', // npm doesn't distinguish in outdated output
        });
      }
    }

    return result;
  } catch (error) {
    console.error(`Failed to scan outdated for ${project.id}:`, error);
    return [];
  }
}

/**
 * Scan a project for vulnerabilities
 */
export async function scanVulnerabilities(
  project: ProjectConfig
): Promise<VulnerabilityInfo[]> {
  const pm = detectPackageManager(project.path);
  if (!pm) return [];

  try {
    let output = '';
    const cmd = pm === 'pnpm'
      ? 'pnpm audit --json'
      : pm === 'npm'
      ? 'npm audit --json'
      : 'yarn audit --json';

    try {
      const { stdout } = await execAsync(cmd, { cwd: project.path });
      output = stdout;
    } catch (err: unknown) {
      const execErr = err as { stdout?: string };
      output = execErr.stdout || '{}';
    }

    const data = JSON.parse(output || '{}');
    const result: VulnerabilityInfo[] = [];

    // pnpm/npm advisories format
    if (data.advisories) {
      for (const advisory of Object.values(data.advisories)) {
        const adv = advisory as {
          module_name: string;
          severity: string;
          title: string;
          findings: Array<{ paths: string[] }>;
          patched_versions: string;
        };
        result.push({
          name: adv.module_name,
          severity: adv.severity as VulnSeverity,
          title: adv.title,
          path: adv.findings?.[0]?.paths?.[0] || adv.module_name,
          fixAvailable: adv.patched_versions !== '<0.0.0',
        });
      }
    }

    // npm v7+ vulnerabilities format
    if (data.vulnerabilities) {
      for (const [name, info] of Object.entries(data.vulnerabilities)) {
        const vuln = info as {
          severity: string;
          via: Array<{ title?: string }>;
          fixAvailable: boolean | { name: string; version: string };
        };
        result.push({
          name,
          severity: vuln.severity as VulnSeverity,
          title: vuln.via?.[0]?.title || 'Vulnerability',
          path: name,
          fixAvailable: !!vuln.fixAvailable,
          fixVersion: typeof vuln.fixAvailable === 'object'
            ? vuln.fixAvailable.version
            : undefined,
        });
      }
    }

    return result;
  } catch (error) {
    console.error(`Failed to scan vulnerabilities for ${project.id}:`, error);
    return [];
  }
}

/**
 * Scan a project (uses cache if valid)
 */
export async function scanProject(
  project: ProjectConfig,
  forceRefresh = false
): Promise<ProjectPatchCache> {
  // Check cache first
  if (!forceRefresh) {
    const cached = readProjectCache(project.id);
    if (cached) return cached;
  }

  // Run scans in parallel
  const [outdated, vulnerabilities] = await Promise.all([
    scanOutdated(project),
    scanVulnerabilities(project),
  ]);

  // Create and save cache
  const cache = createProjectCache(project.id, outdated, vulnerabilities);
  writeProjectCache(cache);

  // Update aggregate state
  updateProjectPatchState(project.id, {
    outdatedCount: outdated.length,
    vulnCount: vulnerabilities.length,
    criticalCount: vulnerabilities.filter(
      v => v.severity === 'critical' || v.severity === 'high'
    ).length,
    lastChecked: cache.timestamp,
  });

  return cache;
}

/**
 * Build priority queue from multiple project caches
 */
export function buildPriorityQueue(
  caches: ProjectPatchCache[]
): { queue: PatchQueueItem[]; summary: PatchSummary } {
  const packageMap = new Map<string, PatchQueueItem>();
  const summary: PatchSummary = {
    critical: 0,
    high: 0,
    moderate: 0,
    outdatedMajor: 0,
    outdatedMinor: 0,
    outdatedPatch: 0,
  };

  // Process vulnerabilities first (higher priority)
  for (const cache of caches) {
    for (const vuln of cache.vulnerabilities) {
      const key = `vuln:${vuln.name}:${vuln.severity}`;
      const existing = packageMap.get(key);

      if (existing) {
        if (!existing.affectedProjects.includes(cache.projectId)) {
          existing.affectedProjects.push(cache.projectId);
        }
      } else {
        packageMap.set(key, {
          priority: getPriorityScore('vulnerability', vuln.severity),
          type: 'vulnerability',
          severity: vuln.severity,
          package: vuln.name,
          currentVersion: '',
          targetVersion: vuln.fixVersion || '',
          updateType: 'patch',
          affectedProjects: [cache.projectId],
          title: vuln.title,
          fixAvailable: vuln.fixAvailable,
        });

        // Update summary
        if (vuln.severity === 'critical') summary.critical++;
        else if (vuln.severity === 'high') summary.high++;
        else if (vuln.severity === 'moderate') summary.moderate++;
      }
    }

    // Process outdated packages
    for (const pkg of cache.outdated) {
      const updateType = getUpdateType(pkg.current, pkg.latest);
      const key = `outdated:${pkg.name}:${pkg.latest}`;
      const existing = packageMap.get(key);

      if (existing) {
        if (!existing.affectedProjects.includes(cache.projectId)) {
          existing.affectedProjects.push(cache.projectId);
        }
      } else {
        packageMap.set(key, {
          priority: getPriorityScore('outdated', updateType),
          type: 'outdated',
          severity: updateType,
          package: pkg.name,
          currentVersion: pkg.current,
          targetVersion: pkg.latest,
          updateType,
          affectedProjects: [cache.projectId],
        });

        // Update summary
        if (updateType === 'major') summary.outdatedMajor++;
        else if (updateType === 'minor') summary.outdatedMinor++;
        else summary.outdatedPatch++;
      }
    }
  }

  // Sort by priority (lower number = higher priority)
  const queue = Array.from(packageMap.values()).sort(
    (a, b) => a.priority - b.priority
  );

  return { queue, summary };
}

/**
 * Get priority score (lower = more urgent)
 */
function getPriorityScore(
  type: 'vulnerability' | 'outdated',
  severity: string
): number {
  if (type === 'vulnerability') {
    switch (severity) {
      case 'critical': return 1;
      case 'high': return 2;
      case 'moderate': return 3;
      case 'low': return 4;
      default: return 5;
    }
  }
  // Outdated
  switch (severity) {
    case 'major': return 10;
    case 'minor': return 20;
    default: return 30;
  }
}
```

**Step 2: Verify module compiles**

Run: `cd /home/aaron/Projects/hexops && pnpm build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/lib/patch-scanner.ts
git commit -m "feat(patches): add patch scanner module with priority queue builder"
```

---

### Task 4: Create Patches API Endpoint

**Files:**
- Create: `src/app/api/patches/route.ts`

**Step 1: Create the API route**

Create directory and file `src/app/api/patches/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { getProjects } from '@/lib/config';
import { readPatchState } from '@/lib/patch-storage';
import { scanProject, buildPriorityQueue } from '@/lib/patch-scanner';

export async function GET() {
  try {
    const projects = getProjects();
    const state = readPatchState();

    // Scan all projects (uses cache if valid)
    const caches = await Promise.all(
      projects.map(project => scanProject(project))
    );

    // Build priority queue
    const { queue, summary } = buildPriorityQueue(caches);

    return NextResponse.json({
      queue,
      summary,
      lastScan: state.lastFullScan,
      projectCount: projects.length,
    });
  } catch (error) {
    console.error('Error fetching patches:', error);
    return NextResponse.json(
      { error: 'Failed to fetch patch data' },
      { status: 500 }
    );
  }
}
```

**Step 2: Verify endpoint works**

Run: `curl http://localhost:3000/api/patches | jq .`
Expected: JSON response with queue, summary, lastScan

**Step 3: Commit**

```bash
git add src/app/api/patches/route.ts
git commit -m "feat(patches): add GET /api/patches endpoint for priority queue"
```

---

### Task 5: Create Patches Scan Endpoint

**Files:**
- Create: `src/app/api/patches/scan/route.ts`

**Step 1: Create the scan endpoint**

Create `src/app/api/patches/scan/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { getProjects } from '@/lib/config';
import { scanProject, buildPriorityQueue } from '@/lib/patch-scanner';
import { writePatchState, readPatchState } from '@/lib/patch-storage';

export async function POST() {
  try {
    const projects = getProjects();

    // Force refresh all projects
    const caches = await Promise.all(
      projects.map(project => scanProject(project, true))
    );

    // Update last scan time
    const state = readPatchState();
    state.lastFullScan = new Date().toISOString();
    writePatchState(state);

    // Build priority queue
    const { queue, summary } = buildPriorityQueue(caches);

    return NextResponse.json({
      success: true,
      queue,
      summary,
      lastScan: state.lastFullScan,
      projectCount: projects.length,
    });
  } catch (error) {
    console.error('Error scanning patches:', error);
    return NextResponse.json(
      { error: 'Failed to scan patches' },
      { status: 500 }
    );
  }
}
```

**Step 2: Verify endpoint works**

Run: `curl -X POST http://localhost:3000/api/patches/scan | jq .`
Expected: JSON response with success: true, queue, summary

**Step 3: Commit**

```bash
git add src/app/api/patches/scan/route.ts
git commit -m "feat(patches): add POST /api/patches/scan endpoint for forced refresh"
```

---

### Task 6: Create Patches History Endpoint

**Files:**
- Create: `src/app/api/patches/history/route.ts`

**Step 1: Create the history endpoint**

Create `src/app/api/patches/history/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { readPatchHistory } from '@/lib/patch-storage';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const projectId = searchParams.get('projectId');
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    const history = readPatchHistory();
    let updates = history.updates;

    // Filter by project if specified
    if (projectId) {
      updates = updates.filter(u => u.projectId === projectId);
    }

    // Apply limit
    updates = updates.slice(0, limit);

    return NextResponse.json({
      updates,
      total: history.updates.length,
    });
  } catch (error) {
    console.error('Error fetching patch history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch patch history' },
      { status: 500 }
    );
  }
}
```

**Step 2: Verify endpoint works**

Run: `curl http://localhost:3000/api/patches/history | jq .`
Expected: JSON response with updates array, total count

**Step 3: Commit**

```bash
git add src/app/api/patches/history/route.ts
git commit -m "feat(patches): add GET /api/patches/history endpoint"
```

---

### Task 7: Enhance Update Endpoint with History Logging

**Files:**
- Modify: `src/app/api/projects/[id]/update/route.ts`

**Step 1: Add history logging to update endpoint**

Update the existing update route to log to history. Replace the entire file:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  addPatchHistoryEntry,
  generatePatchId,
  invalidateProjectCache,
} from '@/lib/patch-storage';
import { getUpdateType } from '@/lib/patch-scanner';
import type { PatchHistoryEntry } from '@/lib/types';

const execAsync = promisify(exec);

interface UpdateRequestBody {
  packages?: Array<{
    name: string;
    fromVersion?: string;
    toVersion: string;
  }>;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body: UpdateRequestBody = await request.json().catch(() => ({}));
    const packages = body.packages || [];

    const project = getProject(id);

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const cwd = project.path;

    // Check for lockfiles to determine which package manager to use
    const hasPnpmLock = existsSync(join(cwd, 'pnpm-lock.yaml'));
    const hasNpmLock = existsSync(join(cwd, 'package-lock.json'));
    const hasYarnLock = existsSync(join(cwd, 'yarn.lock'));

    if (!hasPnpmLock && !hasNpmLock && !hasYarnLock) {
      return NextResponse.json({
        success: false,
        error: 'No lockfile found. Run install first.',
        output: `No lockfile found in ${cwd}`,
      });
    }

    // Determine package manager
    let packageManager: string;
    if (hasPnpmLock) {
      packageManager = 'pnpm';
    } else if (hasNpmLock) {
      packageManager = 'npm';
    } else {
      packageManager = 'yarn';
    }

    const results: Array<{
      package: string;
      success: boolean;
      output: string;
      error?: string;
    }> = [];

    if (packages.length > 0) {
      // Update specific packages
      for (const pkg of packages) {
        // Sanitize package name
        if (!/^[@a-z0-9][\w\-./@]*$/i.test(pkg.name)) {
          results.push({
            package: pkg.name,
            success: false,
            output: '',
            error: 'Invalid package name',
          });
          continue;
        }

        let installCmd: string;
        const targetVersion = pkg.toVersion || 'latest';
        if (packageManager === 'pnpm') {
          installCmd = `pnpm add ${pkg.name}@${targetVersion}`;
        } else if (packageManager === 'npm') {
          installCmd = `npm install ${pkg.name}@${targetVersion}`;
        } else {
          installCmd = `yarn add ${pkg.name}@${targetVersion}`;
        }

        try {
          const { stdout, stderr } = await execAsync(installCmd, {
            cwd,
            timeout: 60000,
          });
          const output = `$ ${installCmd}\n${stdout}${stderr ? stderr : ''}`;

          results.push({
            package: pkg.name,
            success: true,
            output,
          });

          // Log to history
          const historyEntry: PatchHistoryEntry = {
            id: generatePatchId(),
            timestamp: new Date().toISOString(),
            projectId: id,
            package: pkg.name,
            fromVersion: pkg.fromVersion || 'unknown',
            toVersion: targetVersion,
            updateType: pkg.fromVersion
              ? getUpdateType(pkg.fromVersion, targetVersion)
              : 'patch',
            trigger: 'manual',
            success: true,
            output,
          };
          addPatchHistoryEntry(historyEntry);
        } catch (err) {
          const execErr = err as { stdout?: string; stderr?: string; message?: string };
          const output = `$ ${installCmd}\n${execErr.stdout || ''}${execErr.stderr || ''}`;
          const error = execErr.message || 'Update failed';

          results.push({
            package: pkg.name,
            success: false,
            output,
            error,
          });

          // Log failure to history
          const historyEntry: PatchHistoryEntry = {
            id: generatePatchId(),
            timestamp: new Date().toISOString(),
            projectId: id,
            package: pkg.name,
            fromVersion: pkg.fromVersion || 'unknown',
            toVersion: targetVersion,
            updateType: pkg.fromVersion
              ? getUpdateType(pkg.fromVersion, targetVersion)
              : 'patch',
            trigger: 'manual',
            success: false,
            output,
            error,
          };
          addPatchHistoryEntry(historyEntry);
        }
      }
    } else {
      // No packages specified - run standard update within semver range
      let cmd: string;
      if (packageManager === 'pnpm') {
        cmd = 'pnpm update';
      } else if (packageManager === 'npm') {
        cmd = 'npm update';
      } else {
        cmd = 'yarn upgrade';
      }

      const { stdout, stderr } = await execAsync(cmd, {
        cwd,
        timeout: 120000,
      });

      results.push({
        package: '*',
        success: true,
        output: stdout + (stderr ? `\n${stderr}` : ''),
      });
    }

    // Invalidate cache for this project
    invalidateProjectCache(id);

    const allSucceeded = results.every(r => r.success);
    const output = results.map(r => r.output).join('\n\n');

    return NextResponse.json({
      success: allSucceeded,
      packageManager,
      results,
      output: output || 'Packages updated successfully.',
    });
  } catch (error) {
    console.error('Error updating packages:', error);
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    return NextResponse.json({
      success: false,
      error: 'Update command failed',
      output: execError.stdout || execError.stderr || execError.message || 'Unknown error',
    });
  }
}
```

**Step 2: Verify endpoint still works**

Run: `curl -X POST http://localhost:3000/api/projects/hexops/update -H "Content-Type: application/json" -d '{}' | jq .`
Expected: JSON response with success status

**Step 3: Commit**

```bash
git add src/app/api/projects/[id]/update/route.ts
git commit -m "feat(patches): enhance update endpoint with history logging"
```

---

## Phase 1 Complete Checkpoint

At this point you should have:
- Type definitions in `src/lib/types.ts`
- Storage module in `src/lib/patch-storage.ts`
- Scanner module in `src/lib/patch-scanner.ts`
- API endpoints:
  - `GET /api/patches` - Priority queue
  - `POST /api/patches/scan` - Force refresh
  - `GET /api/patches/history` - Update history
- Enhanced `/api/projects/[id]/update` with history logging

**Verify all APIs work:**
```bash
curl http://localhost:3000/api/patches | jq '.summary'
curl -X POST http://localhost:3000/api/patches/scan | jq '.summary'
curl http://localhost:3000/api/patches/history | jq '.total'
```

---

## Phase 2: Patches Page UI

### Task 8: Create Patches Page

**Files:**
- Create: `src/app/patches/page.tsx`

**Step 1: Create the patches page**

Create `src/app/patches/page.tsx`:

```typescript
'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { RefreshCw, ArrowLeft, Shield, Package, ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PatchQueueItem, PatchSummary } from '@/lib/types';
import Link from 'next/link';

interface PatchesData {
  queue: PatchQueueItem[];
  summary: PatchSummary;
  lastScan: string | null;
  projectCount: number;
}

type FilterType = 'all' | 'vulns' | 'outdated';

export default function PatchesPage() {
  const [data, setData] = useState<PatchesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState(false);

  const fetchPatches = useCallback(async () => {
    try {
      const res = await fetch('/api/patches');
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await res.json();
      setData(json);
    } catch (error) {
      console.error('Failed to fetch patches:', error);
      toast.error('Failed to load patch data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPatches();
  }, [fetchPatches]);

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/patches/scan', { method: 'POST' });
      if (!res.ok) throw new Error('Scan failed');
      const json = await res.json();
      setData(json);
      toast.success('Scan complete');
    } catch (error) {
      console.error('Scan failed:', error);
      toast.error('Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const toggleSelection = (key: string) => {
    setSelectedPackages(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (!data) return;
    const keys = filteredQueue.map(item => `${item.type}:${item.package}:${item.targetVersion}`);
    setSelectedPackages(new Set(keys));
  };

  const clearSelection = () => {
    setSelectedPackages(new Set());
  };

  const handleUpdateSelected = async () => {
    if (!data || selectedPackages.size === 0) return;

    setUpdating(true);
    const selectedItems = filteredQueue.filter(
      item => selectedPackages.has(`${item.type}:${item.package}:${item.targetVersion}`)
    );

    // Group by project for batch updates
    const updatesByProject = new Map<string, Array<{ name: string; toVersion: string; fromVersion: string }>>();

    for (const item of selectedItems) {
      for (const projectId of item.affectedProjects) {
        if (!updatesByProject.has(projectId)) {
          updatesByProject.set(projectId, []);
        }
        updatesByProject.get(projectId)!.push({
          name: item.package,
          toVersion: item.targetVersion,
          fromVersion: item.currentVersion,
        });
      }
    }

    let successCount = 0;
    let failCount = 0;

    for (const [projectId, packages] of updatesByProject) {
      try {
        const res = await fetch(`/api/projects/${projectId}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packages }),
        });
        const result = await res.json();
        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    setUpdating(false);
    setSelectedPackages(new Set());

    if (failCount === 0) {
      toast.success(`Updated packages in ${successCount} project(s)`);
    } else {
      toast.warning(`${successCount} succeeded, ${failCount} failed`);
    }

    // Refresh data
    fetchPatches();
  };

  if (loading) {
    return (
      <div className="flex h-screen bg-zinc-950 items-center justify-center">
        <div className="text-zinc-500">Loading patch data...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-screen bg-zinc-950 items-center justify-center">
        <div className="text-red-400">Failed to load patch data</div>
      </div>
    );
  }

  const filteredQueue = data.queue.filter(item => {
    if (filter === 'vulns') return item.type === 'vulnerability';
    if (filter === 'outdated') return item.type === 'outdated';
    return true;
  });

  const { summary } = data;
  const totalIssues = summary.critical + summary.high + summary.moderate +
    summary.outdatedMajor + summary.outdatedMinor + summary.outdatedPatch;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="sm" className="text-zinc-400">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Dashboard
              </Button>
            </Link>
            <h1 className="text-xl font-semibold">Patches</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500">
              {data.lastScan
                ? `Last scan: ${new Date(data.lastScan).toLocaleString()}`
                : 'Never scanned'}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="border-zinc-700"
              onClick={handleScan}
              disabled={scanning}
            >
              <RefreshCw className={cn('h-4 w-4 mr-2', scanning && 'animate-spin')} />
              {scanning ? 'Scanning...' : 'Scan All'}
            </Button>
          </div>
        </div>
      </header>

      {/* Summary Bar */}
      <div className="border-b border-zinc-800 px-6 py-3 bg-zinc-900/50">
        <div className="flex items-center gap-6">
          {summary.critical > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-sm text-red-400">{summary.critical} critical</span>
            </div>
          )}
          {summary.high > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-orange-500" />
              <span className="text-sm text-orange-400">{summary.high} high</span>
            </div>
          )}
          {summary.outdatedMajor > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-yellow-500" />
              <span className="text-sm text-yellow-400">{summary.outdatedMajor} major</span>
            </div>
          )}
          {(summary.outdatedMinor + summary.outdatedPatch) > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-zinc-500" />
              <span className="text-sm text-zinc-400">
                {summary.outdatedMinor + summary.outdatedPatch} minor/patch
              </span>
            </div>
          )}
          {totalIssues === 0 && (
            <span className="text-sm text-green-400">All packages up to date!</span>
          )}
        </div>
      </div>

      {/* Filters & Actions */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 mr-2">Filter:</span>
          <Button
            variant={filter === 'all' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setFilter('all')}
          >
            All ({data.queue.length})
          </Button>
          <Button
            variant={filter === 'vulns' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setFilter('vulns')}
          >
            <Shield className="h-3 w-3 mr-1" />
            Vulnerabilities
          </Button>
          <Button
            variant={filter === 'outdated' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setFilter('outdated')}
          >
            <Package className="h-3 w-3 mr-1" />
            Outdated
          </Button>
        </div>

        {selectedPackages.size > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400">{selectedPackages.size} selected</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-zinc-400"
              onClick={clearSelection}
            >
              Clear
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs bg-purple-600 hover:bg-purple-700"
              onClick={handleUpdateSelected}
              disabled={updating}
            >
              <ArrowUp className={cn('h-3 w-3 mr-1', updating && 'animate-bounce')} />
              {updating ? 'Updating...' : 'Update Selected'}
            </Button>
          </div>
        )}

        {selectedPackages.size === 0 && filteredQueue.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-zinc-400"
            onClick={selectAll}
          >
            Select All
          </Button>
        )}
      </div>

      {/* Queue List */}
      <div className="p-6 space-y-2">
        {filteredQueue.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            {filter === 'all'
              ? 'No patches needed — all packages are up to date!'
              : `No ${filter === 'vulns' ? 'vulnerabilities' : 'outdated packages'} found`}
          </div>
        ) : (
          filteredQueue.map((item) => {
            const key = `${item.type}:${item.package}:${item.targetVersion}`;
            const isSelected = selectedPackages.has(key);

            return (
              <div
                key={key}
                className={cn(
                  'flex items-center gap-4 p-4 rounded-lg border transition-colors cursor-pointer',
                  isSelected
                    ? 'bg-purple-500/10 border-purple-500/30'
                    : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700'
                )}
                onClick={() => toggleSelection(key)}
              >
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => toggleSelection(key)}
                />

                <SeverityBadge type={item.type} severity={item.severity} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{item.package}</span>
                    {item.currentVersion && (
                      <>
                        <span className="text-zinc-500 font-mono text-sm">
                          {item.currentVersion}
                        </span>
                        <span className="text-zinc-600">→</span>
                        <span className="text-green-400 font-mono text-sm">
                          {item.targetVersion}
                        </span>
                      </>
                    )}
                    <Badge variant="outline" className="text-xs border-zinc-700 text-zinc-500">
                      {item.updateType}
                    </Badge>
                  </div>
                  {item.title && (
                    <p className="text-sm text-zinc-500 truncate mt-1">{item.title}</p>
                  )}
                  <p className="text-xs text-zinc-600 mt-1">
                    Affects: {item.affectedProjects.join(', ')}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function SeverityBadge({ type, severity }: { type: string; severity: string }) {
  if (type === 'vulnerability') {
    const styles: Record<string, string> = {
      critical: 'bg-red-500/20 text-red-400 border-red-500/50',
      high: 'bg-orange-500/20 text-orange-400 border-orange-500/50',
      moderate: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
      low: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
      info: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/50',
    };
    return (
      <Badge variant="outline" className={cn('text-xs uppercase w-20 justify-center', styles[severity])}>
        {severity}
      </Badge>
    );
  }

  // Outdated
  const styles: Record<string, string> = {
    major: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
    minor: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
    patch: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/50',
  };
  return (
    <Badge variant="outline" className={cn('text-xs uppercase w-20 justify-center', styles[severity])}>
      {severity}
    </Badge>
  );
}
```

**Step 2: Verify page loads**

Open: `http://localhost:3000/patches`
Expected: Patches page with priority queue visible

**Step 3: Commit**

```bash
git add src/app/patches/page.tsx
git commit -m "feat(patches): add dedicated Patches page with priority queue UI"
```

---

### Task 9: Add Patches Link to Sidebar

**Files:**
- Modify: `src/components/sidebar.tsx`

**Step 1: Read current sidebar implementation**

Read the file to understand the structure before modifying.

**Step 2: Add Patches navigation item**

Add a link to `/patches` in the sidebar navigation. Look for the navigation items section and add:

```tsx
<Link href="/patches">
  <Button
    variant="ghost"
    className={cn(
      'w-full justify-start text-sm',
      'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
    )}
  >
    <Package className="h-4 w-4 mr-3" />
    Patches
  </Button>
</Link>
```

**Step 3: Verify navigation works**

Click "Patches" in sidebar → should navigate to `/patches`

**Step 4: Commit**

```bash
git add src/components/sidebar.tsx
git commit -m "feat(patches): add Patches link to sidebar navigation"
```

---

## Phase 2 Complete Checkpoint

At this point you should have:
- Dedicated Patches page at `/patches`
- Priority queue display with filtering
- Selection and batch update capability
- Sidebar navigation to Patches page

**Verify:**
1. Navigate to `http://localhost:3000/patches`
2. Click "Scan All" and see results
3. Select packages and update them
4. Check that sidebar has Patches link

---

## Remaining Phases (Summary)

### Phase 3: Dashboard Integration
- Task 10: Create dashboard summary widget component
- Task 11: Add project row badges showing patch status
- Task 12: Integrate widget into main page

### Phase 4: Context & History
- Task 13: Add changelog fetching from npm registry
- Task 14: Create expandable package detail panel
- Task 15: Create history view component
- Task 16: Add history tab/panel to Patches page

---

**Implementation continues in subsequent tasks. Complete Phase 1 and Phase 2 first, then proceed.**
