# Project Detail Page Design

**Date:** 2026-01-18
**Status:** Approved for v1 implementation

## Overview

Add a project detail page that functions like a web hosting control panel for local dev sites. Users can view detailed info, run diagnostics, and manage individual projects.

## Navigation Pattern

**View Switching:**
- Main content area switches between List View and Detail View
- Left sidebar remains visible for navigation back to list
- Right sidebar kept (purpose TBD)

**Getting to Detail:**
- "Details" button in actions column of project row
- Replaces list with detail view (no route change for v1)

**Getting Back:**
- "Back to Projects" link at top of detail page
- Clicking any left sidebar category returns to list

**State:**
```typescript
viewMode: 'list' | 'detail'
detailProjectId: string | null
```

## Detail Page Layout

### Header Bar
- Project name and path
- Status indicator (running/stopped)
- Port number
- Primary actions: Start/Stop, Clear Cache, Delete Lock
- Quick links: Open in Browser, Open in IDE

### Content Sections (Collapsible)

| Section | Description |
|---------|-------------|
| **Logs** | Live log viewer with auto-scroll, clear button |
| **Info** | package.json details, available scripts, node version |
| **Environment** | .env file viewer (read-only v1) |
| **Package Health** | Deps list, versions, outdated check, CVE audit |
| **Git** | Branch, last commit, dirty status, uncommitted count |
| **Performance** | Uptime, memory usage, port status |

### Package Health Details
- List all dependencies with current versions
- Run `pnpm outdated` on-demand for update check
- Run `pnpm audit` on-demand for CVE detection
- Cache results, show badges/indicators
- Architected for future: background scans, external APIs

## Implementation Notes

### New Components
- `ProjectDetail` - Main detail page container
- `DetailHeader` - Header bar with status and actions
- `LogsSection` - Collapsible log viewer
- `InfoSection` - Package.json info display
- `EnvSection` - Environment variables viewer
- `PackageHealthSection` - Deps, outdated, audit
- `GitSection` - Git status display
- `PerformanceSection` - Runtime metrics

### New API Routes
- `GET /api/projects/[id]/info` - Package.json, node version
- `GET /api/projects/[id]/env` - Environment variables
- `GET /api/projects/[id]/outdated` - Run pnpm outdated
- `GET /api/projects/[id]/audit` - Run pnpm audit
- `GET /api/projects/[id]/git` - Git status info

### State Management
- Add viewMode/detailProjectId to page.tsx
- Each section manages its own loading/data state
- Consider section-level caching for audit results

## Future Considerations
- URL routing (`/projects/[id]`) for bookmarkability
- Environment variable editing
- Background security scanning
- External API integration (Snyk, Socket.dev)
- Batch operations across projects
