# HexOps Escalate State — Design Spec

**Date:** 2026-04-21
**Issue:** #70
**PR:** Separate from #71 (branch propagation)
**Status:** Approved — pending implementation plan

---

## Problem

When Dependabot marks a vulnerability as `fixAvailable: false`, HexOps has no action path. The vuln sits flagged indefinitely with no resolution options. Additionally, Dependabot-managed projects currently disable all manual patching in the UI — meaning even emergency overrides are blocked.

This creates a binary: auto-patch or do nothing. We need a third state: **Escalate**.

---

## Solution Overview

Add an Escalate flow triggered on any `fixAvailable: false` vulnerability row. Three actions are available:

| Action | What it does | Auto-commit/push |
|--------|-------------|------------------|
| Force Override | Pins transitive dep via `overrides`/`resolutions` in package.json + regenerates lockfile | Configurable per project (or immediate via "Oh Shit" button) |
| Force Major Bump | Updates dep version in package.json only | Never — always manual review |
| Accept Risk | Records reason + expiry, suppresses vuln from queue | No file changes |

---

## Data Model

### `EscalateRecord` — `.hexops/patches/escalations.json`

```typescript
interface EscalateRecord {
  id: string                    // uuid
  projectId: string
  package: string
  action: 'force_override' | 'force_major' | 'accepted_risk'
  reason: string
  createdAt: string             // ISO 8601
  expiresAt?: string            // accepted_risk only — enforced max from project config
  resolvedAt?: string           // set by scanner when upstream patch ships
  overrideVersion?: string      // force_override: version pinned to
  targetVersion?: string        // force_major: target version
}
```

`escalations.json` is a flat array of `EscalateRecord[]`. Persists independently of the 1-hour patch cache TTL.

### Per-project config additions — `hexops.config.json`

```json
{
  "projects": {
    "my-project": {
      "escalation": {
        "acceptedRiskMaxDays": 90,
        "autoCommit": false,
        "autoPush": false
      }
    }
  }
}
```

- `acceptedRiskMaxDays` — enforced ceiling on accept-risk expiry. Default: 90.
- `autoCommit` / `autoPush` — controls force_override post-patch behavior. Default: false.
- Force Major Bump **ignores** these settings — always manual, no exceptions.

---

## Backend

### New API Routes

**`POST /api/projects/[id]/escalate`**

Request body:
```typescript
{
  package: string
  action: 'force_override' | 'force_major' | 'accepted_risk'
  reason: string
  overrideVersion?: string      // force_override
  targetVersion?: string        // force_major
  expiresAt?: string            // accepted_risk
  emergency?: boolean           // force_override only — bypasses autoCommit/autoPush config
}
```

Action execution:
- `force_override` — injects `overrides`/`resolutions` entry into `package.json`, runs `lockfile-resolver.ts` to regenerate lockfile, then commits + pushes per project config (or immediately if `emergency: true`).
- `force_major` — updates dep version in `package.json` only. Never commits. Returns a pending state for UI banner.
- `accepted_risk` — writes `EscalateRecord` only. No file changes.

**`DELETE /api/projects/[id]/escalate/[escalationId]`**

Removes the escalation record. Vuln re-surfaces in the patch queue on next scan.

Escalation data is served through the existing patches stream — no dedicated GET route needed.

### Scanner Integration — `patch-scanner.ts`

After building `PatchQueueItem[]`, load `escalations.json` and process each vuln:

| Condition | Behavior |
|-----------|----------|
| `accepted_risk` + not expired | Suppress from queue. Add to separate accepted-risk list. |
| `accepted_risk` + expired | Re-surface in queue with `escalationExpired: true` flag. |
| `force_override` or `force_major` + npm audit now shows `fixAvailable: true` | Set `resolvedAt` on record. Re-surface as normal patchable item. |

The scanner is the source of truth for expiry and resolution detection. No cron job needed — checks run on every scan.

---

## Frontend

### Escalate Button

Appears on any `fixAvailable: false` row, **including Dependabot-managed projects** (currently these rows have no action). Secondary button styling alongside the severity badge.

### `<EscalateModal>` — New Standalone Component

Extracted from `patches/page.tsx` to keep the page manageable.

**Structure:**
- Header: package name + CVE/advisory link
- Three option cards (radio-style selection):

**Option 1 — Force Override**
- Auto-detected safe pinned version shown
- Auto-commit toggle (reflects project config default)
- Auto-push toggle (reflects project config default, only enabled if auto-commit on)
- **"Oh Shit" button** — red, labeled "Patch Now". Visible only when Force Override is selected. Ignores all config — commits and pushes immediately.

**Option 2 — Force Major Bump**
- Target version displayed
- Prominent breaking-changes warning
- Confirms user understands this requires manual review before merge

**Option 3 — Accept Risk**
- Required reason field (text, cannot submit empty)
- Expiry date picker — capped at `acceptedRiskMaxDays` from project config
- Shows calculated expiry clearly ("Expires April 21, 2026")

### Accepted Risk Panel

Collapsible section below the main patch queue, per project. Only shown when project has active accepted-risk records.

- Package name, reason, expiry countdown ("Expires in 14 days")
- Expired entries float to top with red "Expired" badge — no longer suppressed from queue
- "Reverse" button — calls DELETE endpoint, removes record

### Pending Major Bump Banner

Amber banner at top of project section when a `force_major` escalation is pending (no `resolvedAt`).

- Shows: package name, current → target version
- "Review & Commit" CTA — opens file diff view or links to the project directory

### Expired Badge

Vulns with an expired `accepted_risk` record re-appear in the main queue with an "Expired" tag. Visually distinct from new findings so the user knows this was a prior accepted-risk, not a new discovery.

---

## Error Handling

- `force_override` with lockfile regeneration failure → surface error in the escalate modal, do not write `EscalateRecord`. User must resolve lockfile manually before escalating.
- `accepted_risk` with missing reason → block form submission client-side.
- `accepted_risk` with expiry exceeding `acceptedRiskMaxDays` → clamp to max silently, show clamped date to user before submit.
- DELETE on a non-existent escalation → 404, UI removes the record optimistically anyway.

---

## What This Does Not Cover

- Branch propagation after Dependabot merges — tracked separately in #71
- Auto-detection of when a Force Major Bump has been committed (no `resolvedAt` auto-set for major bumps — user must manually reverse the escalation after merging)

---

## Related Issues

- #70 — This feature
- #71 — Branch propagation (separate PR)
- #68 — Self-advisory transitive vulns (fixed in v0.12.0)
- #64 — Override-aware patching (related, precursor work)
- #65 — Dependabot monitor mode (related integration)
