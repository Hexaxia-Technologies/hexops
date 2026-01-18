# HexOps Patch Management System Design

**Date:** 2026-01-18
**Status:** Approved
**Author:** Aaron + Claude

## Overview

A comprehensive patch management system for HexOps that provides visibility into package health across all managed projects, enables safe updates with full context, and logs update history for auditing.

## Goals

1. **Visibility** — See which projects have outdated/vulnerable packages at a glance
2. **Safe updates** — Update packages confidently with changelog preview, impact analysis, and semver classification
3. **Automation** — Scan on dashboard load, cache results, persist history

## Current State

The existing implementation provides:
- Per-project outdated package detection (pnpm/npm/yarn)
- Security audit via `pnpm audit`
- Individual package updates
- In-memory caching (5 min TTL, lost on restart)

Missing:
- Aggregate view across all projects
- Priority-based queue (severity ranking)
- Changelog/context before updating
- Persistent storage and history
- Batch updates across projects

---

## Data Model & Storage

### File Structure

```
.hexops/
├── patches/
│   ├── state.json           # Current patch status for all projects
│   ├── history.json         # Log of all updates performed
│   └── cache/
│       └── {projectId}.json # Per-project scan results with TTL
```

### state.json — Aggregate View Data

```json
{
  "lastFullScan": "2026-01-18T10:30:00Z",
  "projects": {
    "sailbot": {
      "outdatedCount": 5,
      "vulnCount": 2,
      "criticalCount": 1,
      "lastChecked": "2026-01-18T10:30:00Z"
    }
  }
}
```

### history.json — Append-Only Update Log

```json
{
  "updates": [
    {
      "id": "upd_abc123",
      "timestamp": "2026-01-18T10:35:00Z",
      "projectId": "sailbot",
      "package": "lodash",
      "fromVersion": "4.17.20",
      "toVersion": "4.17.21",
      "updateType": "patch",
      "trigger": "manual",
      "success": true,
      "output": "$ pnpm add lodash@4.17.21\n+ lodash@4.17.21"
    }
  ]
}
```

### Cache Files

Per-project scan results stored in `cache/{projectId}.json`. Expires after 1 hour. Contains full outdated/audit data to avoid re-running expensive npm commands.

---

## API Layer

### New Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/patches` | GET | Get aggregate state across all projects (priority queue) |
| `/api/patches/scan` | POST | Trigger full scan of all projects, updates cache |
| `/api/patches/history` | GET | Get update history, supports `?projectId=` filter |
| `/api/patches/package/:name` | GET | Get info for a specific package (changelog, affected projects) |

### Enhanced Existing Endpoints

| Endpoint | Change |
|----------|--------|
| `/api/projects/[id]/update` | Now logs to history.json, returns richer response |

### Priority Queue Response

`GET /api/patches` returns:

```json
{
  "queue": [
    {
      "priority": 1,
      "type": "vulnerability",
      "severity": "critical",
      "package": "lodash",
      "currentVersion": "4.17.20",
      "fixVersion": "4.17.21",
      "updateType": "patch",
      "affectedProjects": ["sailbot", "hexcms"],
      "title": "Prototype Pollution in lodash"
    },
    {
      "priority": 2,
      "type": "outdated",
      "severity": "major",
      "package": "react",
      "currentVersion": "18.2.0",
      "latestVersion": "19.2.3",
      "updateType": "major",
      "affectedProjects": ["sailbot"]
    }
  ],
  "summary": {
    "critical": 1,
    "high": 0,
    "outdatedMajor": 3,
    "outdatedMinor": 8,
    "outdatedPatch": 12
  },
  "lastScan": "2026-01-18T10:30:00Z"
}
```

**Priority ordering:** critical vulns → high vulns → moderate vulns → outdated majors → outdated minors → outdated patches

---

## UI Design

### Dedicated Patches Page

New view accessible from sidebar navigation.

```
┌─────────────────────────────────────────────────────────────┐
│ Patches                                    [Scan All] [⟳]   │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 🔴 1 critical  🟠 0 high  🟡 3 major  ○ 20 minor/patch  │ │
│ │ Last scan: 2 minutes ago                                │ │
│ └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│ Filter: [All ▾] [Vulns only] [Outdated only] [Project ▾]   │
├─────────────────────────────────────────────────────────────┤
│ ☐ CRITICAL  lodash 4.17.20 → 4.17.21 (patch)               │
│   Prototype Pollution vulnerability                         │
│   Affects: sailbot, hexcms                    [Update All]  │
├─────────────────────────────────────────────────────────────┤
│ ☐ MAJOR  react 18.2.0 → 19.2.3                             │
│   Affects: sailbot                             [View Diff]  │
├─────────────────────────────────────────────────────────────┤
│ ☐ MINOR  framer-motion 12.20.0 → 12.26.2                   │
│   Affects: hexops, sailbot, hexcms       [Update Selected]  │
└─────────────────────────────────────────────────────────────┘
```

**Interactions:**
- Select multiple packages → "Update Selected" button appears
- Click package row → expands to show changelog preview + full project list
- "Update All" on a row → updates that package across all affected projects
- Filters persist in URL for bookmarking

### Dashboard Widget

Top of the main project list, above project rows:

```
┌─────────────────────────────────────────────────────────────┐
│ 📦 Package Health                                           │
│ 🔴 1 critical · 🟡 3 outdated major · 20 up to date        │
│                                          [View All Patches] │
└─────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Shows aggregated counts from state.json
- Red accent if any critical/high vulns exist
- "View All Patches" navigates to Patches page
- Auto-refreshes on dashboard load (triggers scan if cache expired)

### Project Row Badge

Add small badge to project rows:

```
┌──────────────────────────────────────────────────────────┐
│ ● SailBot                    :3010   [🔴 1] [Open] [Stop]│
└──────────────────────────────────────────────────────────┘
```

Badge states:
- 🔴 = critical/high vuln
- 🟡 = outdated major or moderate vuln
- No badge = all good or only minor/patch updates

Clicking badge navigates to Patches page filtered to that project.

### Package Context Panel

Expanded view when clicking a package row:

```
┌─────────────────────────────────────────────────────────────┐
│ ▼ lodash 4.17.20 → 4.17.21                          [patch]│
├─────────────────────────────────────────────────────────────┤
│ SEMVER: Patch (safe — bug fixes only)                       │
├─────────────────────────────────────────────────────────────┤
│ CHANGELOG PREVIEW                                           │
│ ─────────────────                                           │
│ 4.17.21 (2024-02-15)                                       │
│ • Fixed prototype pollution in zipObjectDeep               │
│ • Security: CVE-2021-23337                                 │
│                                         [View on npm →]    │
├─────────────────────────────────────────────────────────────┤
│ AFFECTED PROJECTS (2)                                       │
│ ─────────────────────                                       │
│ sailbot      — direct dependency (package.json)            │
│ hexcms       — transitive via @sanity/client               │
├─────────────────────────────────────────────────────────────┤
│ [Update sailbot] [Update hexcms] [Update All]              │
└─────────────────────────────────────────────────────────────┘
```

**Changelog source:** Fetch from npm registry API (`https://registry.npmjs.org/{package}`)

**Dependency type detection:** Parse each project's package.json + lockfile

---

## Update Flow

1. User clicks "Update" (single project or all)
2. Modal confirms: "Update lodash 4.17.20 → 4.17.21 in 2 projects?"
3. Progress UI shows each project being updated
4. Results logged to history.json
5. Cache invalidated, state refreshed

### Update Output Modal

```
┌─────────────────────────────────────────────────────────────┐
│ Updating lodash...                                     [X] │
├─────────────────────────────────────────────────────────────┤
│ sailbot                                              ✓ Done │
│ $ pnpm add lodash@4.17.21                                  │
│ + lodash@4.17.21                                           │
├─────────────────────────────────────────────────────────────┤
│ hexcms                                               ✓ Done │
│ $ pnpm add lodash@4.17.21                                  │
│ + lodash@4.17.21                                           │
├─────────────────────────────────────────────────────────────┤
│ Updated 2 projects successfully            [View History]  │
└─────────────────────────────────────────────────────────────┘
```

### History View

```
┌─────────────────────────────────────────────────────────────┐
│ Update History                              [Filter ▾]     │
├─────────────────────────────────────────────────────────────┤
│ Today, 10:35 AM                                            │
│ ✓ lodash 4.17.20 → 4.17.21 in sailbot         [manual]    │
│ ✓ lodash 4.17.20 → 4.17.21 in hexcms          [manual]    │
├─────────────────────────────────────────────────────────────┤
│ Yesterday, 3:22 PM                                         │
│ ✓ react 18.2.0 → 18.3.1 in sailbot            [manual]    │
│ ✗ typescript 5.3.0 → 5.4.0 in hexops          [manual]    │
│   Error: Peer dependency conflict...          [View Log]   │
└─────────────────────────────────────────────────────────────┘
```

---

## Build Phases

### Phase 1: Core Visibility
- Storage layer (state.json, history.json, cache/)
- New API endpoints (`/api/patches`, `/api/patches/scan`)
- Dedicated Patches page with priority queue
- Basic package rows (no expansion yet)

### Phase 2: Dashboard Integration
- Dashboard widget (summary bar)
- Project row badges
- Link to filtered Patches page

### Phase 3: Context & Confidence
- Package context panel (expandable rows)
- Changelog fetching from npm registry
- Semver classification display
- Direct vs transitive dependency detection

### Phase 4: Operational
- Batch updates across projects
- Update confirmation modal
- Progress UI during updates
- History view with filtering

---

## Technical Notes

### Scanning Strategy
- Scan triggered on dashboard load if cache older than 1 hour
- Per-project scans run in parallel (Promise.all)
- Results written to cache files immediately
- State.json aggregated after all scans complete

### Changelog Fetching
- Use npm registry API: `https://registry.npmjs.org/{package}`
- Cache changelog data in memory (not persisted)
- Fallback to "View on npm" link if fetch fails

### Error Handling
- Failed scans: Show stale cached data with warning
- Failed updates: Log to history with error output, don't block other updates
- Missing lockfile: Skip project with informative message
