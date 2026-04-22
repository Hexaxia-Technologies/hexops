# HexOps Branch Propagation — Design Spec

**Date:** 2026-04-21
**Issue:** #71
**Status:** Approved — pending implementation plan

---

## Problem

Dependabot targets one branch (typically `main`). After a Dependabot PR merges, active feature/dev branches remain on the old dependency versions indefinitely. HexOps reports patching complete based on `main`, but other branches are still exposed.

When `package.json` is later manually synced between branches, `overrides` config changes cause lockfile mismatches (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`) that break Vercel/CI deploys.

---

## Solution Overview

Three moving parts:

1. **Detection** (automatic, scan-time) — compare `package.json` on each active remote branch against `main`, surface out-of-sync branches as a warning in the Dependabot panel.
2. **Propagation** (manual trigger) — user selects branches, HexOps syncs `package.json` from main, regenerates the lockfile, then opens a PR or pushes directly per project config.
3. **Frontend** — warning banner + Propagate button inside the existing `DependabotPanel`. New `<BranchPropagateModal>` component handles branch selection and shows live results.

---

## Data Model

### Type additions — `types.ts`

```typescript
interface BranchSyncStatus {
  branch: string;
  status: 'synced' | 'out_of_sync' | 'conflict' | 'propagated';
  prUrl?: string;        // set when openPR mode and PR was created
  error?: string;        // set when status is 'conflict'
}

interface PropagationConfig {
  activeBranchDays: number;   // default: 30
  openPR: boolean;            // default: true
  autoPush: boolean;          // default: false — only relevant when openPR: false
}
```

### `PatchSummary` additions

```typescript
// Added to existing PatchSummary per-project summary (or ProjectScanResult):
branchesOutOfSync?: string[]   // branch names behind main on package.json deps
```

### Per-project config additions — `hexops.config.json`

```json
{
  "projects": {
    "my-project": {
      "propagation": {
        "activeBranchDays": 30,
        "openPR": true,
        "autoPush": false
      }
    }
  }
}
```

- `activeBranchDays` — branches with no commit in this window are skipped. Default: 30.
- `openPR` — when `true`, creates a GitHub PR from a `hexops/sync-{branch}-{timestamp}` branch targeting the downstream branch. When `false`, pushes directly to the branch.
- `autoPush` — only used when `openPR: false`. Default: false (direct push requires explicit confirmation in modal).

---

## Backend

### New lib: `src/lib/branch-propagator.ts`

Owns all branch sync logic, keeping route handlers thin.

**Exports:**

`getActiveBranches(projectPath, days): Promise<string[]>`
- Runs `git fetch origin` then `git for-each-ref refs/remotes/origin/` filtered by committer date within `days`
- Excludes `main`, `master`, `HEAD`

`getBranchSyncStatuses(projectPath, activeBranches): Promise<BranchSyncStatus[]>`
- For each branch, compares `dependencies`, `devDependencies`, and `overrides` from `git show origin/{branch}:package.json` against `git show origin/main:package.json`
- Returns status `'synced'` or `'out_of_sync'` per branch
- Runs branch reads in parallel

`propagateBranch(projectPath, branch, config, token): Promise<BranchSyncStatus>`
- Creates a temp git worktree at `/tmp/hexops-propagate-{branch}-{timestamp}`
- Checks out the target branch in the worktree
- Runs `git checkout origin/main -- package.json`
- Runs `pnpm/npm/yarn install --no-frozen-lockfile` (PM detected via `detectPackageManager`)
- If `config.openPR`:
  - Commits to `hexops/sync-{branch}-{timestamp}` branch
  - Pushes to origin
  - Opens PR via GitHub API targeting `branch`
  - Returns status `'propagated'` with `prUrl`
- If `!config.openPR`:
  - Commits and pushes directly to `branch`
  - Returns status `'propagated'`
- On `package.json` merge conflict: returns status `'conflict'` with error message
- Always cleans up worktree in a `finally` block

`openPropagationPR(owner, repo, head, base, token): Promise<string>` (in `github-client.ts`)
- Creates a PR via GitHub API, returns the PR URL

### New API Routes

**`GET /api/projects/[id]/branch-sync`**

Returns current sync status for all active branches. Called when opening the propagate modal.

Response:
```typescript
{
  branches: BranchSyncStatus[]
  config: PropagationConfig
}
```

**`POST /api/projects/[id]/propagate-branches`**

Executes propagation for selected branches.

Request:
```typescript
{
  branches: string[]
  openPR?: boolean   // overrides project config for this run
}
```

Response:
```typescript
{
  results: BranchSyncStatus[]
  skipped: string[]   // branches that were already in sync
}
```

### Scanner Integration — `patch-scanner.ts`

After building `PatchQueueItem[]` for a Dependabot-managed project, call `getBranchSyncStatuses()` and attach the list of out-of-sync branch names to the project's summary entry.

- Only runs for Dependabot-managed projects (skip others — no value, extra cost)
- Runs regardless of GitHub token (branch comparison is local git only — no API calls at scan time)
- Failures in branch detection are non-fatal — log and continue, don't block the scan

---

## Frontend

### `DependabotPanel` additions

When `branchesOutOfSync` is non-empty, show an amber warning banner inside the panel:

```
⚠ 2 branches out of sync with main — dev, feature/auth    [Propagate →]
```

Clicking "Propagate →" opens `<BranchPropagateModal>`.

### `<BranchPropagateModal>` — New Standalone Component

**On open:** calls `GET /api/projects/[id]/branch-sync` to get current statuses (may have changed since scan).

**Structure:**
- Branch list with checkboxes (out-of-sync branches checked by default, synced branches shown greyed/unchecked)
- Mode toggle: "Open PR" / "Push directly" — reflects `propagation.openPR` project config default
- Submit button: "Propagate Selected"
- After submit: inline per-branch results replace the checkboxes
  - ✅ PR opened — [link]
  - ✅ Pushed to branch
  - ⚠ Conflict — manual sync needed: `{error message}`

---

## Error Handling

- **No GitHub token + openPR mode** — block submit in modal, show "GitHub token required for PR mode — add token in Settings"
- **`package.json` merge conflict** — mark that branch as `conflict` in results, continue with remaining branches. Do not abort the whole run.
- **Lockfile regen failure** — mark branch as `conflict` with error, revert `package.json` change in the worktree before cleanup
- **Branch already in sync** — skip silently, include in `skipped` response field
- **Worktree cleanup failure** — log error, do not surface to user (non-fatal)

---

## What This Does Not Cover

- Monorepo nested `package.json` files (only root manifest synced)
- Auto-triggering propagation without user confirmation
- Tracking historical propagation runs
- Non-Dependabot-managed projects (branch sync only surfaces for managed projects)

---

## Related Issues

- #71 — This feature
- #70 — Escalate state (separate PR, implemented)
- #65 — Dependabot integration (precursor, implemented in PR #67)
