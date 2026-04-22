# HexOps Branch Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when active git branches are behind `main` on `package.json` deps (after a Dependabot merge), and let the user sync them via a PR or direct push from the Dependabot panel.

**Architecture:** `branch-propagator.ts` owns all git operations (branch listing, dep comparison, worktree-based sync). Two new API routes expose this to the frontend. `DependabotPanel` self-fetches branch sync status and surfaces a warning banner + `BranchPropagateModal`.

**Tech Stack:** Next.js 15 App Router, TypeScript, `execFile` (promisified) for git ops, GitHub REST API for PR creation, existing `detectPackageManager` / `lockfile-resolver.ts` patterns, shadcn/ui components.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/types.ts` | Modify | Add `BranchSyncStatus`, `PropagationConfig`; extend `ProjectConfig` |
| `src/lib/github-client.ts` | Modify | Add `openPropagationPR` function |
| `src/lib/branch-propagator.ts` | **Create** | `getActiveBranches`, `getBranchSyncStatuses`, `propagateBranch` |
| `src/app/api/projects/[id]/branch-sync/route.ts` | **Create** | GET — list branch sync statuses |
| `src/app/api/projects/[id]/propagate-branches/route.ts` | **Create** | POST — execute propagation |
| `src/components/branch-propagate-modal.tsx` | **Create** | Branch selection + live result UI |
| `src/components/detail-sections/dependabot-panel.tsx` | Modify | Add sync warning banner + Propagate button |

---

### Task 1: Add types to `types.ts`

**Files:**
- Modify: `src/lib/types.ts`

**Context:** `ProjectConfig` is at line 28. `DependabotConfig` is at line 177. No test runner exists — use `pnpm tsc --noEmit` from `/home/aaron/Projects/hexops` for verification.

- [ ] **Step 1: Add `BranchSyncStatus` and `PropagationConfig` after `DependabotConfig` (after line 184)**

```typescript
export interface BranchSyncStatus {
  branch: string;
  status: 'synced' | 'out_of_sync' | 'conflict' | 'propagated';
  prUrl?: string;
  error?: string;
}

export interface PropagationConfig {
  activeBranchDays: number;
  openPR: boolean;
  autoPush: boolean;
}
```

- [ ] **Step 2: Add `propagation` field to `ProjectConfig` (after the `github?` field at line 46)**

```typescript
propagation?: Partial<PropagationConfig>;
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd /home/aaron/Projects/hexops && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/aaron/Projects/hexops && git commit src/lib/types.ts -m "feat(branch-prop): add BranchSyncStatus and PropagationConfig types (#71)"
```

---

### Task 2: Add `openPropagationPR` to `github-client.ts`

**Files:**
- Modify: `src/lib/github-client.ts`

**Context:** File already has `fetchDependabotPRs` using `fetch` with GitHub API. Follow the same pattern. Add after the existing `mapPR` function at the bottom of the file.

- [ ] **Step 1: Add the `openPropagationPR` function at the end of `src/lib/github-client.ts`**

```typescript
/**
 * Opens a PR on GitHub from `head` branch targeting `base` branch.
 * Returns the PR's html_url.
 * Throws if token is missing or API call fails.
 */
export async function openPropagationPR(
  owner: string,
  repo: string,
  head: string,
  base: string,
  token: string | null
): Promise<string> {
  if (!token) throw new Error('GitHub token required to open PRs');

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: `chore: sync package.json deps from main → ${base}`,
      head,
      base,
      body: 'Automated branch propagation by HexOps. Syncs `package.json` deps from `main` and regenerates the lockfile.\n\nReview the diff and merge when ready.',
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GitHub PR creation failed (${response.status}): ${text}`);
  }

  const pr = (await response.json()) as { html_url: string };
  return pr.html_url;
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /home/aaron/Projects/hexops && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/aaron/Projects/hexops && git commit src/lib/github-client.ts -m "feat(branch-prop): add openPropagationPR to github-client (#71)"
```

---

### Task 3: Create `src/lib/branch-propagator.ts`

**Files:**
- Create: `src/lib/branch-propagator.ts`

**Context:**
- `detectPackageManager` is exported from `src/lib/patch-scanner.ts`
- Use `execFile` + `promisify` pattern (same as `src/app/api/projects/[id]/escalate/route.ts`)
- `openPropagationPR` is in `src/lib/github-client.ts` (Task 2)
- `PropagationConfig`, `BranchSyncStatus` are in `src/lib/types.ts` (Task 1)
- Default `PropagationConfig`: `{ activeBranchDays: 30, openPR: true, autoPush: false }`

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import { detectPackageManager } from './patch-scanner';
import { openPropagationPR } from './github-client';
import type { BranchSyncStatus, PropagationConfig } from './types';

const execFileAsync = promisify(execFile);

export const DEFAULT_PROPAGATION_CONFIG: PropagationConfig = {
  activeBranchDays: 30,
  openPR: true,
  autoPush: false,
};

const LOCK_FILES: Record<string, string> = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
};

const INSTALL_CMD: Record<string, string[]> = {
  pnpm: ['pnpm', 'install', '--no-frozen-lockfile'],
  npm: ['npm', 'install', '--legacy-peer-deps'],
  yarn: ['yarn', 'install'],
};
```

- [ ] **Step 1: Create `src/lib/branch-propagator.ts` with the header above plus `getActiveBranches`**

```typescript
/**
 * Lists active remote branches (excluding main/master/HEAD) with a commit
 * within the last `days` days. Runs `git fetch` first to ensure current data.
 */
export async function getActiveBranches(
  projectPath: string,
  days: number
): Promise<string[]> {
  await execFileAsync('git', ['fetch', 'origin', '--prune'], {
    cwd: projectPath,
    timeout: 30000,
  });

  const { stdout } = await execFileAsync(
    'git',
    [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short) %(committerdate:iso-strict)',
      'refs/remotes/origin/',
    ],
    { cwd: projectPath, timeout: 10000 }
  );

  const SKIP = new Set(['origin/main', 'origin/master', 'origin/HEAD']);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const branches: string[] = [];

  for (const line of stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    const spaceIdx = line.indexOf(' ');
    const refname = line.slice(0, spaceIdx);
    const date = line.slice(spaceIdx + 1).trim();
    if (SKIP.has(refname)) continue;
    if (date >= cutoff) {
      branches.push(refname.replace('origin/', ''));
    }
  }

  return branches;
}
```

- [ ] **Step 2: Add `getBranchSyncStatuses` to the same file**

```typescript
interface DepSnapshot {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides: Record<string, string>;
  pnpmOverrides: Record<string, string>;
  resolutions: Record<string, string>;
}

function extractDeps(pkg: Record<string, unknown>): DepSnapshot {
  const pnpm = (pkg.pnpm ?? {}) as Record<string, unknown>;
  return {
    dependencies: (pkg.dependencies ?? {}) as Record<string, string>,
    devDependencies: (pkg.devDependencies ?? {}) as Record<string, string>,
    overrides: (pkg.overrides ?? {}) as Record<string, string>,
    pnpmOverrides: ((pnpm.overrides ?? {}) as Record<string, string>),
    resolutions: (pkg.resolutions ?? {}) as Record<string, string>,
  };
}

function depsEqual(a: DepSnapshot, b: DepSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compares package.json dep sections on each branch against origin/main.
 * Runs comparisons in parallel. Branches that can't be read are treated as synced.
 */
export async function getBranchSyncStatuses(
  projectPath: string,
  branches: string[]
): Promise<BranchSyncStatus[]> {
  const { stdout: mainPkgRaw } = await execFileAsync(
    'git',
    ['show', 'origin/main:package.json'],
    { cwd: projectPath, timeout: 10000 }
  );
  const mainDeps = extractDeps(JSON.parse(mainPkgRaw) as Record<string, unknown>);

  return Promise.all(
    branches.map(async (branch): Promise<BranchSyncStatus> => {
      try {
        const { stdout: branchPkgRaw } = await execFileAsync(
          'git',
          ['show', `origin/${branch}:package.json`],
          { cwd: projectPath, timeout: 10000 }
        );
        const branchDeps = extractDeps(JSON.parse(branchPkgRaw) as Record<string, unknown>);
        return {
          branch,
          status: depsEqual(mainDeps, branchDeps) ? 'synced' : 'out_of_sync',
        };
      } catch {
        return { branch, status: 'synced' };
      }
    })
  );
}
```

- [ ] **Step 3: Add `propagateBranch` to the same file**

```typescript
/**
 * Syncs package.json from origin/main onto `branch`, regenerates the lockfile,
 * then either opens a GitHub PR or pushes directly per `config`.
 *
 * Uses a git worktree so the project's working tree is not disturbed.
 * Always removes the worktree in a finally block.
 */
export async function propagateBranch(
  projectPath: string,
  branch: string,
  config: PropagationConfig,
  owner: string,
  repo: string,
  token: string | null
): Promise<BranchSyncStatus> {
  const safeBranch = branch.replace(/[^a-zA-Z0-9-_]/g, '-');
  const worktreePath = `/tmp/hexops-prop-${safeBranch}-${Date.now()}`;

  try {
    // Create worktree on target branch
    await execFileAsync(
      'git',
      ['worktree', 'add', worktreePath, `origin/${branch}`],
      { cwd: projectPath, timeout: 15000 }
    );

    // Apply package.json from main
    try {
      await execFileAsync(
        'git',
        ['checkout', 'origin/main', '--', 'package.json'],
        { cwd: worktreePath, timeout: 10000 }
      );
    } catch (err) {
      return {
        branch,
        status: 'conflict',
        error: `Failed to apply package.json from main: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Check if anything actually changed
    const { stdout: diffOut } = await execFileAsync(
      'git',
      ['diff', '--name-only'],
      { cwd: worktreePath }
    );
    if (!diffOut.trim()) {
      return { branch, status: 'synced' };
    }

    // Regenerate lockfile
    const pm = detectPackageManager(worktreePath);
    const [cmd, ...args] = INSTALL_CMD[pm];
    try {
      await execFileAsync(cmd, args, { cwd: worktreePath, timeout: 120000 });
    } catch (err) {
      // Revert package.json on lockfile failure
      await execFileAsync('git', ['checkout', '--', 'package.json'], { cwd: worktreePath }).catch(() => {});
      return {
        branch,
        status: 'conflict',
        error: `Lockfile regen failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const lockFile = LOCK_FILES[pm];

    if (config.openPR) {
      if (!token) {
        return { branch, status: 'conflict', error: 'GitHub token required for PR mode' };
      }
      const syncBranch = `hexops/sync-${safeBranch}-${Date.now()}`;
      await execFileAsync('git', ['checkout', '-b', syncBranch], { cwd: worktreePath, timeout: 5000 });
      await execFileAsync('git', ['add', 'package.json', lockFile], { cwd: worktreePath });
      await execFileAsync(
        'git',
        ['commit', '-m', `chore: sync package.json from main → ${branch}`],
        { cwd: worktreePath, timeout: 10000 }
      );
      await execFileAsync('git', ['push', 'origin', syncBranch], { cwd: worktreePath, timeout: 30000 });
      try {
        const prUrl = await openPropagationPR(owner, repo, syncBranch, branch, token);
        return { branch, status: 'propagated', prUrl };
      } catch (err) {
        return {
          branch,
          status: 'conflict',
          error: `Branch pushed but PR creation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      await execFileAsync('git', ['add', 'package.json', lockFile], { cwd: worktreePath });
      await execFileAsync(
        'git',
        ['commit', '-m', `chore: sync package.json from main → ${branch}`],
        { cwd: worktreePath, timeout: 10000 }
      );
      await execFileAsync(
        'git',
        ['push', 'origin', `HEAD:${branch}`],
        { cwd: worktreePath, timeout: 30000 }
      );
      return { branch, status: 'propagated' };
    }
  } finally {
    await execFileAsync(
      'git',
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: projectPath, timeout: 10000 }
    ).catch(() => {});
  }
}
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd /home/aaron/Projects/hexops && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/lib/branch-propagator.ts && git commit -m "feat(branch-prop): add branch-propagator lib (#71)"
```

---

### Task 4: Create `GET /api/projects/[id]/branch-sync` route

**Files:**
- Create: `src/app/api/projects/[id]/branch-sync/route.ts`

**Context:** Follow the pattern from `src/app/api/projects/[id]/dependabot/route.ts`. `getProject` and `loadConfig` are from `@/lib/config`. `DEFAULT_PROPAGATION_CONFIG` is from `@/lib/branch-propagator`.

- [ ] **Step 1: Create `src/app/api/projects/[id]/branch-sync/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { getProject, loadConfig } from '@/lib/config';
import {
  getActiveBranches,
  getBranchSyncStatuses,
  DEFAULT_PROPAGATION_CONFIG,
} from '@/lib/branch-propagator';
import type { PropagationConfig } from '@/lib/types';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = getProject(id);

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const config: PropagationConfig = {
    ...DEFAULT_PROPAGATION_CONFIG,
    ...project.propagation,
  };

  try {
    const activeBranches = await getActiveBranches(project.path, config.activeBranchDays);

    if (activeBranches.length === 0) {
      return NextResponse.json({ branches: [], config });
    }

    const branches = await getBranchSyncStatuses(project.path, activeBranches);
    return NextResponse.json({ branches, config });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Branch sync check failed' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /home/aaron/Projects/hexops && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/app/api/projects/\[id\]/branch-sync/ && git commit -m "feat(branch-prop): add GET branch-sync API route (#71)"
```

---

### Task 5: Create `POST /api/projects/[id]/propagate-branches` route

**Files:**
- Create: `src/app/api/projects/[id]/propagate-branches/route.ts`

**Context:** Follow `src/app/api/projects/[id]/escalate/route.ts` for the pattern. `getProject`, `loadConfig` from `@/lib/config`. `propagateBranch`, `DEFAULT_PROPAGATION_CONFIG` from `@/lib/branch-propagator`. GitHub token from `config.settings?.integrations?.github?.token`. `owner`/`repo` from `project.github` or fall back to detecting via `parseGitHubRemote` from `@/lib/dependabot-detector`.

- [ ] **Step 1: Create `src/app/api/projects/[id]/propagate-branches/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getProject, loadConfig } from '@/lib/config';
import { propagateBranch, DEFAULT_PROPAGATION_CONFIG } from '@/lib/branch-propagator';
import { parseGitHubRemote } from '@/lib/dependabot-detector';
import type { BranchSyncStatus, PropagationConfig } from '@/lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = getProject(id);

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.branches) || body.branches.length === 0) {
    return NextResponse.json({ error: 'branches array required' }, { status: 400 });
  }

  const branches = body.branches as string[];
  const openPROverride: boolean | undefined =
    typeof body.openPR === 'boolean' ? body.openPR : undefined;

  const globalConfig = loadConfig();
  const token = globalConfig.settings?.integrations?.github?.token ?? null;

  const propagationConfig: PropagationConfig = {
    ...DEFAULT_PROPAGATION_CONFIG,
    ...project.propagation,
    ...(openPROverride !== undefined ? { openPR: openPROverride } : {}),
  };

  // Resolve owner/repo
  let owner = project.github?.owner ?? null;
  let repo = project.github?.repo ?? null;
  if (!owner || !repo) {
    const remote = await parseGitHubRemote(project.path);
    owner = remote.owner;
    repo = remote.repo;
  }

  if (propagationConfig.openPR && (!owner || !repo)) {
    return NextResponse.json(
      { error: 'Could not determine GitHub owner/repo — configure project.github or ensure git remote points to GitHub' },
      { status: 422 }
    );
  }

  const results: BranchSyncStatus[] = [];
  const skipped: string[] = [];

  for (const branch of branches) {
    const result = await propagateBranch(
      project.path,
      branch,
      propagationConfig,
      owner ?? '',
      repo ?? '',
      token
    );
    if (result.status === 'synced') {
      skipped.push(branch);
    } else {
      results.push(result);
    }
  }

  return NextResponse.json({ results, skipped });
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /home/aaron/Projects/hexops && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/app/api/projects/\[id\]/propagate-branches/ && git commit -m "feat(branch-prop): add POST propagate-branches API route (#71)"
```

---

### Task 6: Create `<BranchPropagateModal>` component

**Files:**
- Create: `src/components/branch-propagate-modal.tsx`

**Context:**
- Pattern matches `src/components/escalate-modal.tsx` (Dialog, Button, Badge from shadcn/ui, `cn` from `@/lib/utils`)
- Import: `Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter` from `@/components/ui/dialog`
- Import: `Button` from `@/components/ui/button`, `Badge` from `@/components/ui/badge`, `Checkbox` from `@/components/ui/checkbox`
- `BranchSyncStatus`, `PropagationConfig` from `@/lib/types`
- On open: GET `/api/projects/${projectId}/branch-sync` to get current statuses
- On submit: POST `/api/projects/${projectId}/propagate-branches` with selected branches + openPR mode
- Three UI states: loading, selection, results

- [ ] **Step 1: Create `src/components/branch-propagate-modal.tsx`**

```typescript
'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { BranchSyncStatus, PropagationConfig } from '@/lib/types';

interface BranchPropagateModalProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

export function BranchPropagateModal({
  projectId,
  open,
  onClose,
}: BranchPropagateModalProps) {
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<BranchSyncStatus[]>([]);
  const [config, setConfig] = useState<PropagationConfig | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openPR, setOpenPR] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<BranchSyncStatus[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setResults(null);
    setSkipped([]);
    setFetchError(null);

    fetch(`/api/projects/${projectId}/branch-sync`)
      .then((r) => r.json())
      .then((data: { branches: BranchSyncStatus[]; config: PropagationConfig; error?: string }) => {
        if (data.error) {
          setFetchError(data.error);
          setLoading(false);
          return;
        }
        setBranches(data.branches);
        setConfig(data.config);
        setOpenPR(data.config.openPR);
        // Default: select all out-of-sync branches
        setSelected(new Set(data.branches.filter((b) => b.status === 'out_of_sync').map((b) => b.branch)));
        setLoading(false);
      })
      .catch((err) => {
        setFetchError(err instanceof Error ? err.message : 'Failed to load branch status');
        setLoading(false);
      });
  }, [open, projectId]);

  const toggleBranch = (branch: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(branch)) next.delete(branch);
      else next.add(branch);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/propagate-branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branches: Array.from(selected), openPR }),
      });
      const data = await res.json();
      setResults(data.results ?? []);
      setSkipped(data.skipped ?? []);
    } catch (err) {
      setResults([{
        branch: 'unknown',
        status: 'conflict',
        error: err instanceof Error ? err.message : 'Request failed',
      }]);
    } finally {
      setSubmitting(false);
    }
  };

  const outOfSync = branches.filter((b) => b.status === 'out_of_sync');
  const synced = branches.filter((b) => b.status === 'synced');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg bg-zinc-900 border-zinc-700">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Propagate Branch Dependencies</DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-zinc-400 py-4">
            <span className="animate-spin">⟳</span> Checking branch sync status…
          </div>
        )}

        {fetchError && (
          <div className="rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
            {fetchError}
          </div>
        )}

        {!loading && !fetchError && results === null && (
          <div className="space-y-4">
            {outOfSync.length === 0 ? (
              <p className="text-sm text-zinc-400">All active branches are in sync with main.</p>
            ) : (
              <>
                <p className="text-sm text-zinc-400">
                  Select branches to sync with main&apos;s <code className="text-zinc-300">package.json</code>:
                </p>
                <div className="space-y-2">
                  {outOfSync.map((b) => (
                    <label
                      key={b.branch}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border p-3 cursor-pointer',
                        selected.has(b.branch)
                          ? 'border-amber-500/30 bg-amber-500/5'
                          : 'border-zinc-700 bg-zinc-800/50'
                      )}
                    >
                      <Checkbox
                        checked={selected.has(b.branch)}
                        onCheckedChange={() => toggleBranch(b.branch)}
                      />
                      <span className="font-mono text-sm text-zinc-200">{b.branch}</span>
                      <Badge variant="outline" className="ml-auto text-xs border-amber-500/30 text-amber-400 bg-amber-500/10">
                        Out of sync
                      </Badge>
                    </label>
                  ))}
                </div>

                {synced.length > 0 && (
                  <p className="text-xs text-zinc-500">
                    {synced.length} branch{synced.length !== 1 ? 'es' : ''} already in sync: {synced.map((b) => b.branch).join(', ')}
                  </p>
                )}

                {/* Mode toggle */}
                <div className="rounded-lg border border-zinc-700 p-3 space-y-2">
                  <p className="text-xs font-medium text-zinc-300">Delivery mode</p>
                  <div className="flex gap-3">
                    <label className={cn('flex items-center gap-2 text-sm cursor-pointer', openPR ? 'text-zinc-100' : 'text-zinc-500')}>
                      <input
                        type="radio"
                        checked={openPR}
                        onChange={() => setOpenPR(true)}
                        className="accent-amber-500"
                      />
                      Open PR per branch
                    </label>
                    <label className={cn('flex items-center gap-2 text-sm cursor-pointer', !openPR ? 'text-zinc-100' : 'text-zinc-500')}>
                      <input
                        type="radio"
                        checked={!openPR}
                        onChange={() => setOpenPR(false)}
                        className="accent-amber-500"
                      />
                      Push directly
                    </label>
                  </div>
                  {openPR && (
                    <p className="text-xs text-zinc-500">Requires GitHub token in Settings.</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {results !== null && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-zinc-300">Results</p>
            {results.map((r) => (
              <div
                key={r.branch}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-sm',
                  r.status === 'propagated'
                    ? 'border-green-500/20 bg-green-500/5'
                    : 'border-red-500/20 bg-red-500/5'
                )}
              >
                <span>{r.status === 'propagated' ? '✅' : '⚠️'}</span>
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-zinc-200">{r.branch}</span>
                  {r.status === 'propagated' && r.prUrl && (
                    <a
                      href={r.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-xs text-amber-400 hover:text-amber-300 underline mt-1"
                    >
                      View PR →
                    </a>
                  )}
                  {r.status === 'propagated' && !r.prUrl && (
                    <p className="text-xs text-green-400 mt-1">Pushed directly to branch</p>
                  )}
                  {r.status === 'conflict' && (
                    <p className="text-xs text-red-400 mt-1">{r.error}</p>
                  )}
                </div>
              </div>
            ))}
            {skipped.length > 0 && (
              <p className="text-xs text-zinc-500">
                Skipped (already in sync): {skipped.join(', ')}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {results === null ? (
            <>
              <Button variant="ghost" onClick={onClose} className="text-zinc-400">
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={submitting || selected.size === 0 || loading}
                className="bg-amber-600 hover:bg-amber-500 text-white"
              >
                {submitting ? 'Propagating…' : `Propagate ${selected.size > 0 ? `(${selected.size})` : ''}`}
              </Button>
            </>
          ) : (
            <Button onClick={onClose} className="bg-zinc-700 hover:bg-zinc-600 text-zinc-100">
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd /home/aaron/Projects/hexops && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/aaron/Projects/hexops && git add src/components/branch-propagate-modal.tsx && git commit -m "feat(branch-prop): add BranchPropagateModal component (#71)"
```

---

### Task 7: Update `DependabotPanel` to show sync warning + Propagate button

**Files:**
- Modify: `src/components/detail-sections/dependabot-panel.tsx`

**Context:** The component currently fetches `GET /api/projects/${projectId}/dependabot` on mount. We add a second fetch for `GET /api/projects/${projectId}/branch-sync`. Add the warning banner and Propagate button after the "View on GitHub" header, before the PR list. `BranchPropagateModal` is in `@/components/branch-propagate-modal`.

- [ ] **Step 1: Add imports and `branchSync` state to `DependabotPanel`**

At the top of `dependabot-panel.tsx`, add to imports:
```typescript
import { BranchPropagateModal } from '@/components/branch-propagate-modal';
import { AlertTriangle, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BranchSyncStatus } from '@/lib/types';
```

Inside the `DependabotPanel` component, add state after `const [loading, setLoading] = useState(true)`:
```typescript
const [outOfSyncBranches, setOutOfSyncBranches] = useState<string[]>([]);
const [propagateOpen, setPropagateOpen] = useState(false);
```

- [ ] **Step 2: Add `branch-sync` fetch alongside the existing `dependabot` fetch**

After the existing `useEffect` that fetches dependabot data, add:
```typescript
useEffect(() => {
  fetch(`/api/projects/${projectId}/branch-sync`)
    .then((r) => r.json())
    .then((data: { branches?: BranchSyncStatus[] }) => {
      const oosNames = (data.branches ?? [])
        .filter((b) => b.status === 'out_of_sync')
        .map((b) => b.branch);
      setOutOfSyncBranches(oosNames);
    })
    .catch(() => {});
}, [projectId]);
```

- [ ] **Step 3: Add the warning banner and modal render inside the component's JSX**

Inside the `return (...)` block, after the `<div className="flex items-center justify-between">` header section (after the "View on GitHub" link `</a>` and before `{config.error && ...}`), add:

```tsx
{outOfSyncBranches.length > 0 && (
  <div className="rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 flex items-center justify-between gap-3">
    <div className="flex items-center gap-2 text-xs text-amber-400">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>
        <strong>{outOfSyncBranches.length}</strong> branch{outOfSyncBranches.length !== 1 ? 'es' : ''} out of sync with main
        <span className="text-amber-500/70 ml-1">— {outOfSyncBranches.join(', ')}</span>
      </span>
    </div>
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 shrink-0"
      onClick={() => setPropagateOpen(true)}
    >
      <GitBranch className="h-3 w-3 mr-1" />
      Propagate →
    </Button>
  </div>
)}
```

At the end of the component's return, before the final closing `</div>`, add:
```tsx
<BranchPropagateModal
  projectId={projectId}
  open={propagateOpen}
  onClose={() => setPropagateOpen(false)}
/>
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd /home/aaron/Projects/hexops && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/aaron/Projects/hexops && git commit src/components/detail-sections/dependabot-panel.tsx -m "feat(branch-prop): add sync warning banner and propagate button to DependabotPanel (#71)"
```

---

### Task 8: Push branch and open PR for #71

**Files:** None — git operations only.

- [ ] **Step 1: Push the branch**

```bash
cd /home/aaron/Projects/hexops && git push origin feature/dependabot-integration
```

- [ ] **Step 2: Open PR via GitHub GraphQL (gh pr edit fails on this repo due to deprecated Projects API)**

The existing PR #67 already covers this branch. Update its title to include #71 using the GraphQL API:

```bash
cd /home/aaron/Projects/hexops && gh api graphql -f query='
mutation {
  updatePullRequest(input: {
    pullRequestId: "PR_kwDOQ70YMs7TbvMt",
    title: "feat: Dependabot integration + escalate state + branch propagation (#65, #70, #71)"
  }) {
    pullRequest { title }
  }
}'
```

Expected output: `{"data":{"updatePullRequest":{"pullRequest":{"title":"feat: Dependabot integration + escalate state + branch propagation (#65, #70, #71)"}}}}`

- [ ] **Step 3: Verify PR at `https://github.com/Hexaxia-Technologies/hexops/pull/67`**

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| `BranchSyncStatus`, `PropagationConfig` types | Task 1 |
| `propagation` config on `ProjectConfig` | Task 1 |
| `openPropagationPR` in github-client | Task 2 |
| `getActiveBranches` | Task 3 |
| `getBranchSyncStatuses` | Task 3 |
| `propagateBranch` — PR mode | Task 3 |
| `propagateBranch` — direct push mode | Task 3 |
| `propagateBranch` — conflict handling | Task 3 |
| Worktree cleanup in finally | Task 3 |
| `GET /api/projects/[id]/branch-sync` | Task 4 |
| `POST /api/projects/[id]/propagate-branches` | Task 5 |
| `openPR` override per run | Task 5 |
| `BranchPropagateModal` — branch selection | Task 6 |
| `BranchPropagateModal` — mode toggle | Task 6 |
| `BranchPropagateModal` — live results | Task 6 |
| `DependabotPanel` — amber warning banner | Task 7 |
| `DependabotPanel` — Propagate button | Task 7 |

All spec requirements covered. No placeholders detected. Types are consistent across all tasks (`BranchSyncStatus.status` values used identically in Task 3 propagator and Task 6 modal). No monorepo / auto-trigger / history tracking — correctly excluded per spec.
